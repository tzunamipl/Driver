// Ground heights along a stage line (pacenotes.js): AWS Terrarium tiles at their deepest zoom,
// decoded like the terrain worker's, bilinear per sample. Tiles are kept between generates.

import { lon2tileX, lat2tileY, localToLatLon } from '../geo.js';
import { ELEVATION_URL } from '../terrain/tileUrls.js';

const ZOOM = 15;
const SIZE = 256; // tile pixels
const NODATA_BELOW = -12000; // Terrarium holes decode to -32768 m
const CACHE_SIZE = 96;
const cache = new Map(); // "x/y" -> Promise<Float32Array> (row-major heights, NaN = hole)

async function fetchTile(x, y) {
  const res = await fetch(ELEVATION_URL(ZOOM, x, y));
  if (!res.ok) throw new Error(`Elevation tile: HTTP ${res.status}`);
  // No colour conversion: the RGB channels are data, not colour.
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const ctx = new OffscreenCanvas(SIZE, SIZE).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
  const heights = new Float32Array(SIZE * SIZE);
  for (let i = 0, p = 0; i < heights.length; i++, p += 4) {
    const h = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
    heights[i] = h < NODATA_BELOW ? NaN : h;
  }
  return heights;
}

/** Tile key of global pixel (gx, gy). */
const tileKey = (gx, gy) => `${Math.floor(gx / SIZE)}/${Math.floor(gy / SIZE)}`;

function tile(key) {
  let promise = cache.get(key);
  if (promise) cache.delete(key); // re-insert as most recent
  else {
    const [x, y] = key.split('/').map(Number);
    promise = fetchTile(x, y);
    promise.catch(() => cache.get(key) === promise && cache.delete(key));
  }
  cache.set(key, promise);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return promise;
}

/** Holes (NaN) filled linearly from the nearest heights either side; all holes = 0. */
function fillHoles(h) {
  let last = -1;
  for (let i = 0; i <= h.length; i++) {
    if (i < h.length && Number.isNaN(h[i])) continue;
    const from = last >= 0 ? h[last] : h[i];
    const to = i < h.length ? h[i] : from;
    for (let j = last + 1; j < i; j++) h[j] = Number.isNaN(from) ? 0 : from + ((to - from) * (j - last)) / (i - last);
    last = i;
  }
  return h;
}

/**
 * Height (m) at every sample of a pacenotes.js stage line.
 * @param {(done: number, total: number) => void} [onProgress] - tiles fetched.
 * @returns {Promise<Float32Array>}
 */
export async function stageHeights({ origin, samples }, onProgress) {
  const n = samples.x.length;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const keys = new Set();
  for (let i = 0; i < n; i++) {
    const { lat, lon } = localToLatLon(samples.x[i], samples.z[i], origin.lat, origin.lon);
    // Pixel centres sit at +0.5: shift so floor() gives the top-left neighbour.
    px[i] = lon2tileX(lon, ZOOM) * SIZE - 0.5;
    py[i] = lat2tileY(lat, ZOOM) * SIZE - 0.5;
    for (const dx of [0, 1]) for (const dy of [0, 1]) keys.add(tileKey(Math.floor(px[i]) + dx, Math.floor(py[i]) + dy));
  }
  const tiles = new Map();
  let done = 0;
  await Promise.all(
    [...keys].map(async (key) => {
      tiles.set(key, await tile(key));
      onProgress?.(++done, keys.size);
    })
  );
  const at = (gx, gy) => {
    const heights = tiles.get(tileKey(gx, gy));
    return heights[(gy - Math.floor(gy / SIZE) * SIZE) * SIZE + (gx - Math.floor(gx / SIZE) * SIZE)];
  };
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x0 = Math.floor(px[i]);
    const y0 = Math.floor(py[i]);
    const fx = px[i] - x0;
    const fy = py[i] - y0;
    let sum = 0;
    let weight = 0;
    for (const [dx, dy, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
      const h = at(x0 + dx, y0 + dy);
      if (Number.isNaN(h)) continue;
      sum += h * w;
      weight += w;
    }
    heights[i] = weight > 0 ? sum / weight : NaN;
  }
  return fillHoles(heights);
}
