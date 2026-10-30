import * as THREE from 'three';

// Texture upgrades go to the GPU a few pieces per frame (levels over 1024 px arrive split, tileWorker.js):
// a 4096 px mosaic in one go held Chrome's GPU process, and so the next frame, for ~70 ms.
const PIXELS_PER_FRAME = 1024 * 1024;

/** Textures filled piece by piece, oldest first; `update(renderer)` once per frame. */
export function createTextureUploads() {
  const queue = []; // { owner, texture, pieces: [{ level, x, y, bitmap }], onDone, allocated }
  const source = new THREE.Texture(); // never uploaded itself: copyTextureToTexture texSubImages its image
  const at = new THREE.Vector2();

  return {
    /**
     * `mips` = levels, each an ImageBitmap or { width, height, pieces: [{ x, y, bitmap }] }; `texture` = one with
     * size-only mipmaps, which gets storage only. `onDone(texture)` once every piece is copied in.
     */
    start(owner, texture, mips, onDone) {
      texture.source.dataReady = false;
      const pieces = mips.flatMap((mip, level) => (mip.pieces ?? [{ x: 0, y: 0, bitmap: mip }]).map((piece) => ({ level, ...piece })));
      queue.push({ owner, texture, pieces, onDone, allocated: false });
    },

    pending() {
      return queue.length;
    },

    cancel(owner) {
      const i = queue.findIndex((upload) => upload.owner === owner);
      if (i < 0) return;
      const [upload] = queue.splice(i, 1);
      for (const piece of upload.pieces) piece.bitmap.close();
      upload.texture.dispose();
    },

    update(renderer) {
      let budget = PIXELS_PER_FRAME;
      while (queue.length && budget > 0) {
        const upload = queue[0];
        if (!upload.allocated) {
          renderer.initTexture(upload.texture);
          upload.allocated = true;
        }
        while (upload.pieces.length && budget > 0) {
          const { level, x, y, bitmap } = upload.pieces.shift();
          source.image = bitmap;
          renderer.copyTextureToTexture(source, upload.texture, null, at.set(x, y), 0, level);
          budget -= bitmap.width * bitmap.height;
          bitmap.close();
        }
        source.image = null;
        if (upload.pieces.length) return;
        queue.shift();
        upload.onDone(upload.texture);
      }
    },
  };
}
