// Fetches + decodes terrain tiles off the main thread: Terrarium PNG ->
// Float32 elevations, and an aerial mosaic -> ImageBitmap mip chain. Detail tiles
// come back as a finished surface with the road bed (detailSurface.js). Never throws:
// a failed elevation comes back as {error}, missing aerial quadrants use coarser imagery.
// A {cancel: id} message aborts that job's imagery and answers it {aborted: true}
// (shared elevation / road fetches are cached for other jobs, so they run on).
import { AERIAL_URL, ELEVATION_URL, AERIAL_TILE_SIZE } from './tileUrls.js';
import { loadRoadLines } from './roadBed.js';
import { buildDetailSurface } from './detailSurface.js';

// Decoded elevations, shared by a tile, its neighbours' borders and overzoomed tiles cropping it.
const ELEVATION_CACHE_SIZE = 96;
// Zoom levels to step up for a missing aerial tile (6: one ancestor pixel per 4x4 output pixels).
const AERIAL_FALLBACK_LEVELS = 6;
const ELEVATION_MAX_ZOOM = 15; // Terrarium's deepest level; finer tiles crop their ancestor
const elevationCache = new Map(); // "z/x/y" -> Promise<{heights, width, height} | {error}>

const controllers = new Map(); // job id -> AbortController

async function fetchBitmap(url, options, signal) {
  const res = await fetch(url, { signal });
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
 * Tile (z, x, y) plus a `border`-pixel frame read from the neighbouring tiles,
 * so tiles see identical data around their shared edge. Beyond
 * ELEVATION_MAX_ZOOM it's a crop of the ancestor's pixels, `border` rounded up
 * to them. Missing neighbours repeat the ancestor's edge pixels instead.
 */
async function loadElevation(z, x, y, border) {
  const az = Math.min(z, ELEVATION_MAX_ZOOM);
  const s = 2 ** (z - az);
  const ax = Math.floor(x / s);
  const ay = Math.floor(y / s);
  const own = await cachedElevation(az, ax, ay);
  if (own.error) return own;
  const b = Math.ceil(border / s);
  const span = own.width / s; // ancestor pixels across this tile
  return cropMosaic(az, ax, ay, own, (x % s) * span - b, (y % s) * span - b, span + 2 * b, b);
}

/** `w` x `w` window from pixel (x0, y0) of ancestor `own`, reading past its edge into the neighbouring tiles. */
async function cropMosaic(z, ax, ay, own, x0, y0, w, border) {
  const { width: W, height: H } = own;
  const n = 2 ** z;
  const tx0 = Math.floor(x0 / W);
  const ty0 = Math.floor(y0 / H);
  const tx1 = Math.floor((x0 + w - 1) / W);
  const ty1 = Math.floor((y0 + w - 1) / H);
  const tiles = new Map(); // "dx/dy" -> elevation (same size as `own`) | null
  const loads = [];
  for (let dy = ty0; dy <= ty1; dy++) {
    for (let dx = tx0; dx <= tx1; dx++) {
      const key = `${dx}/${dy}`;
      const nx = ax + dx;
      const ny = ay + dy;
      if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= n || ny >= n) {
        tiles.set(key, dx === 0 && dy === 0 ? own : null);
        continue;
      }
      loads.push(cachedElevation(z, nx, ny).then((t) => tiles.set(key, !t.error && t.width === W && t.height === H ? t : null)));
    }
  }
  await Promise.all(loads);
  const heights = new Float32Array(w * w);
  for (let r = 0; r < w; r++) {
    const py = y0 + r;
    const dy = Math.floor(py / H);
    for (let c = 0; c < w; c++) {
      const px = x0 + c;
      const dx = Math.floor(px / W);
      const tile = tiles.get(`${dx}/${dy}`);
      heights[r * w + c] = tile
        ? tile.heights[(py - dy * H) * W + (px - dx * W)]
        : own.heights[Math.min(H - 1, Math.max(0, py)) * W + Math.min(W - 1, Math.max(0, px))];
    }
  }
  return { heights, width: w, height: w, border };
}

/**
 * Mip chain (full size down to 1x1) for tile (z, x, y), stitched from its 2^boost x 2^boost child tiles.
 * Missing children are filled upscaled from the nearest coarser tile; null if nothing loaded.
 */
async function loadAerial(z, x, y, boost, signal) {
  const n = 2 ** boost;
  const zz = z + boost;
  const canvas = new OffscreenCanvas(n * AERIAL_TILE_SIZE, n * AERIAL_TILE_SIZE);
  const ctx = canvas.getContext('2d');
  const fetched = new Map(); // url -> Promise<ImageBitmap | null>, shared by quadrants falling back to one ancestor
  const fetchOnce = (tz, tx, ty) => {
    const url = AERIAL_URL(tz, tx, ty);
    if (!fetched.has(url)) fetched.set(url, fetchBitmap(url, undefined, signal).catch(() => null));
    return fetched.get(url);
  };
  let drawn = 0;
  const loads = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const qx = x * n + i;
      const qy = y * n + j;
      loads.push(
        (async () => {
          for (let k = 0; k <= AERIAL_FALLBACK_LEVELS && zz - k >= 0; k++) {
            const bmp = await fetchOnce(zz - k, qx >> k, qy >> k);
            if (signal.aborted) return;
            if (!bmp) continue;
            const s = AERIAL_TILE_SIZE / 2 ** k; // this quadrant's share of the ancestor
            const sx = (qx - ((qx >> k) << k)) * s;
            const sy = (qy - ((qy >> k) << k)) * s;
            ctx.drawImage(bmp, sx, sy, s, s, i * AERIAL_TILE_SIZE, j * AERIAL_TILE_SIZE, AERIAL_TILE_SIZE, AERIAL_TILE_SIZE);
            drawn++;
            return;
          }
        })()
      );
    }
  }
  await Promise.all(loads);
  for (const promise of fetched.values()) (await promise)?.close();
  return drawn ? buildMips(canvas) : null;
}

/** Halves `canvas` down to 1x1; GPU generateMipmap on a big texture stalls weak GPUs for hundreds of ms. */
function buildMips(canvas) {
  const levels = [canvas];
  for (let size = canvas.width / 2; size >= 1; size /= 2) {
    const level = new OffscreenCanvas(size, size);
    level.getContext('2d').drawImage(levels.at(-1), 0, 0, size, size);
    levels.push(level);
  }
  return levels.map((level) => level.transferToImageBitmap());
}

self.onmessage = async ({ data: job }) => {
  if (job.cancel != null) {
    controllers.get(job.cancel)?.abort();
    return;
  }
  const { id, z, x, y, elevation, elevationBorder = 0, aerialBoost, detail } = job;
  const controller = new AbortController();
  controllers.set(id, controller);
  const [elev, mips, roadLines] = await Promise.all([
    elevation ? loadElevation(z, x, y, elevationBorder) : null,
    aerialBoost != null ? loadAerial(z, x, y, aerialBoost, controller.signal).catch(() => null) : null,
    detail?.roadBed ? loadRoadLines(z, x, y, detail.widthMeters, detail.heightMeters, detail.widthMeters / detail.cells) : null,
  ]);
  controllers.delete(id);
  if (controller.signal.aborted) {
    mips?.forEach((mip) => mip.close());
    self.postMessage({ id, aborted: true });
    return;
  }
  const transfer = [];
  if (mips) transfer.push(...mips);
  if (detail) {
    // Failed elevation builds flat (main thread decides what to do with it).
    let surface;
    try {
      surface = buildDetailSurface({ ...detail, elev: elev?.heights ? elev : null, lines: roadLines ?? [] });
    } catch (err) {
      self.postMessage({ id, elev: { error: String(err) }, mips, surface: null }, transfer);
      return;
    }
    const { mesh, heightfield, roadProfile } = surface;
    transfer.push(mesh.positions.buffer, mesh.normals.buffer, mesh.uvs.buffer, mesh.indices.buffer, heightfield.heights.buffer);
    transfer.push(roadProfile.original.buffer, roadProfile.adjusted.buffer);
    self.postMessage({ id, elev: elev?.heights ? { ok: true } : elev, mips, surface }, transfer);
    return;
  }
  if (elev?.heights) transfer.push(elev.heights.buffer);
  self.postMessage({ id, elev, mips }, transfer);
};
