// Fetches + decodes terrain tiles off the main thread: Terrarium PNG ->
// Float32 elevations, and an aerial mosaic -> ImageBitmap mip chain. Detail tiles
// come back as a finished surface with the road bed and forest floor (detailSurface.js). Never throws:
// a failed elevation comes back as {error}, no-data pixels are filled from the nearest ancestor that has
// them (`fallbackZoom` says the coarsest used), missing aerial quadrants use coarser imagery.
// Imagery also comes with a `swatch`: the mosaic's SWATCH_SIZE mip as RGB bytes (trees.js crown colours).
// A {cancel: id} message aborts that job's imagery and answers it {aborted: true}
// (shared elevation / road fetches are cached for other jobs, so they run on).
import { AERIAL_URL, AERIAL_TILEMAP_URL, ELEVATION_URL, AERIAL_TILE_SIZE } from './tileUrls.js';
import { loadRoadLines } from './roadBed.js';
import { buildDetailSurface } from './detailSurface.js';
import { loadForestFloor } from './forestFloor.js';

// Decoded elevations, shared by a tile, its neighbours' borders and overzoomed tiles cropping it.
const ELEVATION_CACHE_SIZE = 96;
// Zoom levels to step up for a missing aerial tile (6: one ancestor pixel per 4x4 output pixels).
const AERIAL_FALLBACK_LEVELS = 6;
const ELEVATION_MAX_ZOOM = 15; // Terrarium's deepest level; finer tiles crop their ancestor
// Terrarium serves some holes as HTTP 200 all-black PNGs (-32768 m) and some coasts with deep spikes;
// below the lowest dry land (~-430 m) is treated as no-data, since the sea draws flat over it anyway.
const ELEVATION_NODATA_BELOW = -500;
const ELEVATION_HOLE_BELOW = -12000; // genuine holes, logged as a fallback (deep sea fills silently)
const elevationCache = new Map(); // "z/x/y" -> Promise<{heights, width, height} | {error}>

const controllers = new Map(); // job id -> AbortController
// Aerial tile existence, asked of the tilemap per aligned block: a missing tile's request
// 404s without CORS headers, which the browser logs as a CORS error.
const TILEMAP_BLOCK = 32; // tiles per side
const TILEMAP_CACHE_SIZE = 512; // blocks
const TILEMAP_TIMEOUT_MS = 5000; // a stalled lookup counts as unknown rather than holding the job
const tilemapCache = new Map(); // "z/bx/by" -> Promise<{ data, location } | null>

async function fetchBitmap(url, options, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return createImageBitmap(await res.blob(), options);
}

function tilemapBlock(z, bx, by) {
  const key = `${z}/${bx}/${by}`;
  let promise = tilemapCache.get(key);
  if (promise) {
    tilemapCache.delete(key); // re-insert as most recent
  } else {
    promise = fetch(AERIAL_TILEMAP_URL(z, bx * TILEMAP_BLOCK, by * TILEMAP_BLOCK, TILEMAP_BLOCK), {
      signal: AbortSignal.timeout(TILEMAP_TIMEOUT_MS),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => (json?.valid && json.data ? json : null))
      .catch(() => null);
    // Failures aren't cached, so a retry asks again.
    promise.then((block) => !block && tilemapCache.get(key) === promise && tilemapCache.delete(key));
  }
  tilemapCache.set(key, promise);
  while (tilemapCache.size > TILEMAP_CACHE_SIZE) tilemapCache.delete(tilemapCache.keys().next().value);
  return promise;
}

/** False only where the tilemap says aerial tile (z, x, y) doesn't exist; unknown counts as there. */
async function aerialTileExists(z, x, y) {
  const block = await tilemapBlock(z, Math.floor(x / TILEMAP_BLOCK), Math.floor(y / TILEMAP_BLOCK));
  if (!block) return true;
  const { left, top, width, height } = block.location;
  const col = x - left;
  const row = y - top;
  if (col < 0 || row < 0 || col >= width || row >= height) return true;
  return block.data[row * width + col] === 1;
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

/**
 * Decoded tile with its no-data pixels filled bilinearly from the (filled)
 * parent. Filling the cached tile itself means a tile and its neighbours'
 * border reads see the same heights, so shared edges still match.
 */
async function decodeFilledElevation(z, x, y) {
  const elev = await decodeElevation(z, x, y);
  if (elev.error) return elev;
  const { heights, width: W, height: H } = elev;
  if (!heights.some((h) => h < ELEVATION_NODATA_BELOW)) return elev;
  if (z === 0) {
    for (let i = 0; i < heights.length; i++) heights[i] = Math.max(heights[i], ELEVATION_NODATA_BELOW);
    return elev;
  }
  const holes = heights.some((h) => h < ELEVATION_HOLE_BELOW);
  const parent = await cachedElevation(z - 1, x >> 1, y >> 1);
  if (parent.error) return parent;
  const { heights: ph, width: PW, height: PH } = parent;
  const at = (px, py) => ph[Math.min(PH - 1, Math.max(0, py)) * PW + Math.min(PW - 1, Math.max(0, px))];
  for (let r = 0; r < H; r++) {
    // This pixel's centre in parent pixels (the child covers one quadrant of the parent).
    const fy = (((y & 1) + (r + 0.5) / H) * PH) / 2 - 0.5;
    const py = Math.floor(fy);
    const v = fy - py;
    for (let c = 0; c < W; c++) {
      const i = r * W + c;
      if (heights[i] >= ELEVATION_NODATA_BELOW) continue;
      const fx = (((x & 1) + (c + 0.5) / W) * PW) / 2 - 0.5;
      const px = Math.floor(fx);
      const u = fx - px;
      const top = at(px, py) * (1 - u) + at(px + 1, py) * u;
      const bottom = at(px, py + 1) * (1 - u) + at(px + 1, py + 1) * u;
      heights[i] = top * (1 - v) + bottom * v;
    }
  }
  return { heights, width: W, height: H, fallbackZoom: holes ? (parent.fallbackZoom ?? z - 1) : parent.fallbackZoom };
}

/** Cached decode of tile (z, x, y); the result is shared - never transfer or mutate it. */
function cachedElevation(z, x, y) {
  const key = `${z}/${x}/${y}`;
  let promise = elevationCache.get(key);
  if (promise) {
    elevationCache.delete(key); // re-insert as most recent
  } else {
    promise = decodeFilledElevation(z, x, y);
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
  const elev = await cropMosaic(az, ax, ay, own, (x % s) * span - b, (y % s) * span - b, span + 2 * b, b);
  if (own.fallbackZoom != null) elev.fallbackZoom = own.fallbackZoom;
  return elev;
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

const SWATCH_SIZE = 16; // px per side
// Bigger levels go out in pieces of this size, uploaded a few per frame (terrain/mosaicUpload.js).
const MOSAIC_PIECE = 1024; // px per side

/**
 * { mips, swatch }: mip chain (full size down to 1x1) for tile (z, x, y), stitched from its 2^boost x 2^boost child tiles.
 * Missing children are filled upscaled from the nearest coarser tile; null if nothing loaded.
 * `swatch` = { size, rgb } of the SWATCH_SIZE level, rows north to south.
 */
async function loadAerial(z, x, y, boost, signal) {
  const fetched = new Map(); // url -> Promise<ImageBitmap | null>, shared by quadrants falling back to one ancestor
  const fetchOnce = (tz, tx, ty) => {
    const url = AERIAL_URL(tz, tx, ty);
    if (!fetched.has(url)) {
      const load = aerialTileExists(tz, tx, ty).then((exists) => (exists ? fetchBitmap(url, undefined, signal) : null));
      fetched.set(url, load.catch(() => null));
    }
    return fetched.get(url);
  };
  // Imagery often stops short of the asked zoom: stitching from a coarser level would build
  // a far bigger texture with no more detail, so step down to the finest level with any child.
  for (; boost > 0; boost--) {
    const n = 2 ** boost;
    const exists = await Promise.all(
      Array.from({ length: n * n }, (_, i) => aerialTileExists(z + boost, x * n + (i % n), y * n + Math.floor(i / n)))
    );
    if (signal.aborted) return null;
    if (exists.some(Boolean)) break;
  }
  const n = 2 ** boost;
  const zz = z + boost;
  const canvas = new OffscreenCanvas(n * AERIAL_TILE_SIZE, n * AERIAL_TILE_SIZE);
  const ctx = canvas.getContext('2d');
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
  let swatch = null;
  for (let size = canvas.width / 2; size >= 1; size /= 2) {
    const level = new OffscreenCanvas(size, size);
    const ctx = level.getContext('2d');
    ctx.drawImage(levels.at(-1), 0, 0, size, size);
    if (size === SWATCH_SIZE) {
      const rgba = ctx.getImageData(0, 0, size, size).data;
      const rgb = new Uint8Array(size * size * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
        rgb[j] = rgba[i];
        rgb[j + 1] = rgba[i + 1];
        rgb[j + 2] = rgba[i + 2];
      }
      swatch = { size, rgb };
    }
    levels.push(level);
  }
  return { mips: levels.map((level) => (level.width > MOSAIC_PIECE ? splitLevel(level) : level.transferToImageBitmap())), swatch };
}

/** { width, height, pieces: [{ x, y, bitmap }] } of MOSAIC_PIECE squares. */
function splitLevel(level) {
  const pieces = [];
  for (let y = 0; y < level.height; y += MOSAIC_PIECE) {
    for (let x = 0; x < level.width; x += MOSAIC_PIECE) {
      const piece = new OffscreenCanvas(MOSAIC_PIECE, MOSAIC_PIECE);
      piece.getContext('2d').drawImage(level, x, y, MOSAIC_PIECE, MOSAIC_PIECE, 0, 0, MOSAIC_PIECE, MOSAIC_PIECE);
      pieces.push({ x, y, bitmap: piece.transferToImageBitmap() });
    }
  }
  return { width: level.width, height: level.height, pieces };
}

/** Every ImageBitmap of a mip chain (pieced levels included). */
function mipBitmaps(mips) {
  return mips.flatMap((mip) => (mip.pieces ? mip.pieces.map((piece) => piece.bitmap) : [mip]));
}

self.onmessage = async ({ data: job }) => {
  if (job.cancel != null) {
    controllers.get(job.cancel)?.abort();
    return;
  }
  const { id, z, x, y, elevation, elevationBorder = 0, aerialBoost, detail } = job;
  const controller = new AbortController();
  controllers.set(id, controller);
  const cellMeters = detail && detail.widthMeters / detail.cells;
  const [elev, aerial, roadLines, floorAt] = await Promise.all([
    elevation ? loadElevation(z, x, y, elevationBorder) : null,
    aerialBoost != null ? loadAerial(z, x, y, aerialBoost, controller.signal).catch(() => null) : null,
    detail?.roadBed ? loadRoadLines(z, x, y, detail.widthMeters, detail.heightMeters, cellMeters) : null,
    // Grid nodes reach a few cells past the edges (normals ring, physics square).
    detail ? loadForestFloor(z, x, y, detail.widthMeters, detail.heightMeters, 3 * cellMeters) : null,
  ]);
  controllers.delete(id);
  const mips = aerial?.mips ?? null;
  const swatch = aerial?.swatch ?? null;
  if (controller.signal.aborted) {
    if (mips) mipBitmaps(mips).forEach((bitmap) => bitmap.close());
    self.postMessage({ id, aborted: true });
    return;
  }
  const transfer = [];
  if (mips) transfer.push(...mipBitmaps(mips));
  if (swatch) transfer.push(swatch.rgb.buffer);
  if (detail) {
    // Failed elevation builds flat (main thread decides what to do with it).
    let surface;
    try {
      surface = buildDetailSurface({ ...detail, elev: elev?.heights ? elev : null, lines: roadLines ?? [], floorAt });
    } catch (err) {
      self.postMessage({ id, elev: { error: String(err) }, mips, surface: null }, transfer);
      return;
    }
    const { mesh, heightfield, roadProfile } = surface;
    transfer.push(mesh.positions.buffer, mesh.normals.buffer, mesh.uvs.buffer, mesh.indices.buffer, heightfield.heights.buffer);
    transfer.push(roadProfile.original.buffer, roadProfile.adjusted.buffer, roadProfile.causes.buffer);
    const elevResult = elev?.heights ? { ok: true, fallbackZoom: elev.fallbackZoom } : elev;
    self.postMessage({ id, elev: elevResult, mips, swatch, surface }, transfer);
    return;
  }
  if (elev?.heights) transfer.push(elev.heights.buffer);
  self.postMessage({ id, elev, mips, swatch }, transfer);
};
