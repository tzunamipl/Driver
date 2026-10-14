// Fetches + decodes terrain tiles off the main thread: Terrarium PNG ->
// Float32 elevations, and an aerial mosaic -> ImageBitmap. Detail tiles
// come back as a finished surface with the road bed (detailSurface.js). Never throws:
// a failed elevation comes back as {error}, failed aerial quadrants stay blank.
import { AERIAL_URL, ELEVATION_URL, AERIAL_TILE_SIZE } from './tileUrls.js';
import { loadRoadLines } from './roadBed.js';
import { buildDetailSurface } from './detailSurface.js';

// Decoded elevations, shared by a tile and its neighbours' borders.
const ELEVATION_CACHE_SIZE = 96;
const elevationCache = new Map(); // "z/x/y" -> Promise<{heights, width, height} | {error}>

async function fetchBitmap(url, options) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return createImageBitmap(await res.blob(), options);
}

async function decodeElevation(z, x, y) {
  try {
    // No colour conversion: the RGB channels are data, not colour.
    const bmp = await fetchBitmap(ELEVATION_URL(z, x, y), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none',
    });
    const { width, height } = bmp;
    const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const { data } = ctx.getImageData(0, 0, width, height);
    const heights = new Float32Array(width * height);
    for (let i = 0, p = 0; i < heights.length; i++, p += 4) {
      // Terrarium decoding (Mapzen): (R*256 + G + B/256) - 32768.
      heights[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
    }
    return { heights, width, height };
  } catch (err) {
    return { error: String(err) };
  }
}

/** Cached decode of tile (z, x, y); the result is shared - never transfer or mutate it. */
function cachedElevation(z, x, y) {
  const key = `${z}/${x}/${y}`;
  let promise = elevationCache.get(key);
  if (promise) {
    elevationCache.delete(key); // re-insert as most recent
  } else {
    promise = decodeElevation(z, x, y);
    // Failures aren't cached, so a retry refetches.
    promise.then((elev) => elev.error && elevationCache.get(key) === promise && elevationCache.delete(key));
  }
  elevationCache.set(key, promise);
  while (elevationCache.size > ELEVATION_CACHE_SIZE) elevationCache.delete(elevationCache.keys().next().value);
  return promise;
}

/**
 * Tile (z, x, y) plus a `border`-pixel frame copied from its 8 neighbours,
 * so neighbouring tiles see identical data around their shared edge. A
 * missing neighbour's strip repeats this tile's edge pixels instead.
 */
async function loadElevation(z, x, y, border) {
  const own = await cachedElevation(z, x, y);
  if (own.error || !border) return own.error ? own : { ...own, heights: own.heights.slice() };
  const n = 2 ** z;
  const neighbours = await Promise.all(
    [-1, 0, 1].flatMap((dy) =>
      [-1, 0, 1].map((dx) => {
        const nx = x + dx;
        const ny = y + dy;
        if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= n || ny >= n) return null;
        return cachedElevation(z, nx, ny);
      })
    )
  );
  const { width: w, height: h } = own;
  const bw = w + 2 * border;
  const bh = h + 2 * border;
  const heights = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    const py = by - border; // pixel row in this tile's own coordinates
    const dy = py < 0 ? -1 : py >= h ? 1 : 0;
    for (let bx = 0; bx < bw; bx++) {
      const px = bx - border;
      const dx = px < 0 ? -1 : px >= w ? 1 : 0;
      const src = neighbours[(dy + 1) * 3 + (dx + 1)];
      const tile = src && !src.error && src.width === w && src.height === h ? src : own;
      const sx = tile === own ? Math.min(w - 1, Math.max(0, px)) : px - dx * w;
      const sy = tile === own ? Math.min(h - 1, Math.max(0, py)) : py - dy * h;
      heights[by * bw + bx] = tile.heights[sy * w + sx];
    }
  }
  return { heights, width: bw, height: bh, border };
}

/** One bitmap for tile (z, x, y), stitched from its 2^boost x 2^boost child tiles. */
async function loadAerial(z, x, y, boost) {
  const n = 2 ** boost;
  const canvas = new OffscreenCanvas(n * AERIAL_TILE_SIZE, n * AERIAL_TILE_SIZE);
  const ctx = canvas.getContext('2d');
  const loads = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      loads.push(
        fetchBitmap(AERIAL_URL(z + boost, x * n + i, y * n + j))
          .then((bmp) => {
            ctx.drawImage(bmp, i * AERIAL_TILE_SIZE, j * AERIAL_TILE_SIZE, AERIAL_TILE_SIZE, AERIAL_TILE_SIZE);
            bmp.close();
          })
          .catch(() => {})
      );
    }
  }
  await Promise.all(loads);
  return canvas.transferToImageBitmap();
}

self.onmessage = async ({ data: job }) => {
  const { id, z, x, y, elevation, elevationBorder = 0, aerialBoost, detail } = job;
  const [elev, bitmap, roadLines] = await Promise.all([
    elevation ? loadElevation(z, x, y, elevationBorder) : null,
    aerialBoost != null ? loadAerial(z, x, y, aerialBoost).catch(() => null) : null,
    detail ? loadRoadLines(z, x, y, detail.widthMeters, detail.heightMeters) : null,
  ]);
  const transfer = [];
  if (bitmap) transfer.push(bitmap);
  if (detail) {
    // Failed elevation builds flat (main thread decides what to do with it).
    let surface;
    try {
      surface = buildDetailSurface({ ...detail, elev: elev?.heights ? elev : null, lines: roadLines });
    } catch (err) {
      self.postMessage({ id, elev: { error: String(err) }, bitmap, surface: null }, transfer);
      return;
    }
    const { mesh, heightfield } = surface;
    transfer.push(mesh.positions.buffer, mesh.normals.buffer, mesh.uvs.buffer, mesh.indices.buffer, heightfield.heights.buffer);
    self.postMessage({ id, elev: elev?.heights ? { ok: true } : elev, bitmap, surface }, transfer);
    return;
  }
  if (elev?.heights) transfer.push(elev.heights.buffer);
  self.postMessage({ id, elev, bitmap }, transfer);
};
