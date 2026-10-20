// Forest floor for detail terrain (runs in tileWorker.js): value noise on
// grid nodes inside OSM forest (landcover, as landcoverAreas.js) that lie at
// least FOREST_FLOOR_ROAD_GAP_M from every street line's edge, faded in over
// FADE_METERS so road beds and their banks stay clean. The noise is in
// global tile units, so neighbouring tiles agree on their shared edge.

import { fetchVectorTileLayer } from '../tiles/openFreeMap.js';
import { cachedRoadTile, ROAD_TILE_ZOOM } from './roadBed.js';
import { FOREST_FLOOR_NOISE_M, TREE_GAP_M } from '../../config.js';

export const FOREST_LANDCOVER_ZOOM = 14; // the landcover layer's maxzoom
export const FOREST_LANDCOVER_CLASSES = new Set(['wood']);

const FOREST_FLOOR_ROAD_GAP_M = 2 * TREE_GAP_M;
const FADE_METERS = TREE_GAP_M;
// Noise lattice per DETAIL_ZOOM tile (~200 m): ~25 m swells plus ~12 m bumps at half strength.
const NOISE_OCTAVES = [
  [8, 1],
  [16, 0.5],
];
const NOISE_NORM = NOISE_OCTAVES.reduce((sum, [, weight]) => sum + weight, 0);
const CACHE_SIZE = 16;

// "x/y" -> Promise<Array<{ rings: [[x, y, ...]], minX, maxX, minY, maxY }>>, one per forest
// feature, flat points in global FOREST_LANDCOVER_ZOOM tile units.
const cache = new Map();

async function decodeForestTile(tx, ty) {
  const layer = await fetchVectorTileLayer(FOREST_LANDCOVER_ZOOM, tx, ty, 'landcover');
  const out = [];
  if (!layer) return out;
  const extent = layer.extent;
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 3 || !FOREST_LANDCOVER_CLASSES.has(feature.properties.class)) continue;
    const rings = feature.loadGeometry().map((ring) => ring.flatMap((pt) => [tx + pt.x / extent, ty + pt.y / extent]));
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const ring of rings) {
      for (let k = 0; k < ring.length; k += 2) {
        minX = Math.min(minX, ring[k]);
        maxX = Math.max(maxX, ring[k]);
        minY = Math.min(minY, ring[k + 1]);
        maxY = Math.max(maxY, ring[k + 1]);
      }
    }
    out.push({ rings, minX, maxX, minY, maxY });
  }
  return out;
}

function cachedForestTile(tx, ty) {
  const key = `${tx}/${ty}`;
  let promise = cache.get(key);
  if (promise) {
    cache.delete(key); // re-insert as most recent
  } else {
    promise = decodeForestTile(tx, ty);
    promise.catch(() => cache.get(key) === promise && cache.delete(key));
  }
  cache.set(key, promise);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return promise;
}

/** Even-odd over all of a feature's rings: outers and holes alike. */
function inFeature(px, py, { rings }) {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const xi = ring[i];
      const yi = ring[i + 1];
      const xj = ring[j];
      const yj = ring[j + 1];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function hash2(ix, iy) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 0xffffffff;
}

/** Smooth value noise in [-1, 1] at lattice coordinates (u, v). */
function valueNoise(u, v) {
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  let fu = u - iu;
  let fv = v - iv;
  fu = fu * fu * (3 - 2 * fu);
  fv = fv * fv * (3 - 2 * fv);
  const a = hash2(iu, iv);
  const b = hash2(iu + 1, iv);
  const c = hash2(iu, iv + 1);
  const d = hash2(iu + 1, iv + 1);
  return (a + (b - a) * fu + (c - a + (d - c - b + a) * fu) * fv) * 2 - 1;
}

/**
 * Forest floor offset sampler for detail tile (z, x, y) in its own frame (see
 * roadBed.js loadRoadLines), reaching `marginMeters` past its edges: `floorAt(x, z)`
 * in metres, or null if no forest is near. Resolves to null if the tiles fail.
 */
export async function loadForestFloor(z, x, y, widthMeters, heightMeters, marginMeters) {
  if (!(FOREST_FLOOR_NOISE_M > 0)) return null;
  const toTile = (zoom, f) => f * 2 ** (zoom - z);
  const marginX = marginMeters / widthMeters;
  const marginY = marginMeters / heightMeters;
  const range = (zoom) => ({
    x0: Math.floor(toTile(zoom, x - marginX)),
    x1: Math.floor(toTile(zoom, x + 1 + marginX)),
    y0: Math.floor(toTile(zoom, y - marginY)),
    y1: Math.floor(toTile(zoom, y + 1 + marginY)),
  });
  const tilesIn = ({ x0, x1, y0, y1 }, load) => {
    const out = [];
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push(load(tx, ty));
    return out;
  };

  let forestLists;
  try {
    forestLists = await Promise.all(tilesIn(range(FOREST_LANDCOVER_ZOOM), cachedForestTile));
  } catch (err) {
    console.warn('Forest floor: landcover tiles failed, building plain terrain', z, x, y, err);
    return null;
  }
  // Global landcover tile units -> this tile's metres.
  const forestScale = 2 ** (z - FOREST_LANDCOVER_ZOOM);
  const toLocalX = (gx, scale) => (gx * scale - x) * widthMeters;
  const toLocalY = (gy, scale) => (gy * scale - y) * heightMeters;
  const features = [];
  for (const list of forestLists) {
    for (const f of list) {
      const minX = toLocalX(f.minX, forestScale);
      const maxX = toLocalX(f.maxX, forestScale);
      const minZ = toLocalY(f.minY, forestScale);
      const maxZ = toLocalY(f.maxY, forestScale);
      if (maxX < -marginMeters || minX > widthMeters + marginMeters) continue;
      if (maxZ < -marginMeters || minZ > heightMeters + marginMeters) continue;
      features.push({ ...f, minX, maxX, minZ, maxZ });
    }
  }
  if (!features.length) return null;

  // Street lines within reach of any node that can get noise: [ax, az, bx, bz, halfWidth, ...].
  let roadLists;
  try {
    roadLists = await Promise.all(tilesIn(range(ROAD_TILE_ZOOM), cachedRoadTile));
  } catch (err) {
    console.warn('Forest floor: road tiles failed, building plain terrain', z, x, y, err);
    return null;
  }
  const roadScale = 2 ** (z - ROAD_TILE_ZOOM);
  const reach = marginMeters + FOREST_FLOOR_ROAD_GAP_M + FADE_METERS;
  const segments = [];
  for (const { clearance } of roadLists) {
    for (const { points: p, halfWidth } of clearance) {
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = toLocalX(p[i], roadScale);
        const az = toLocalY(p[i + 1], roadScale);
        const bx = toLocalX(p[i + 2], roadScale);
        const bz = toLocalY(p[i + 3], roadScale);
        if (Math.max(ax, bx) < -reach || Math.min(ax, bx) > widthMeters + reach) continue;
        if (Math.max(az, bz) < -reach || Math.min(az, bz) > heightMeters + reach) continue;
        segments.push(ax, az, bx, bz, halfWidth);
      }
    }
  }

  const fadeEnd = FOREST_FLOOR_ROAD_GAP_M + FADE_METERS;
  /** Metres from (px, pz) to the nearest street edge, capped at fadeEnd. */
  function roadDistance(px, pz) {
    let best = fadeEnd;
    for (let k = 0; k < segments.length; k += 5) {
      const ax = segments[k];
      const az = segments[k + 1];
      const bx = segments[k + 2];
      const bz = segments[k + 3];
      const pad = best + segments[k + 4];
      if (px < Math.min(ax, bx) - pad || px > Math.max(ax, bx) + pad) continue;
      if (pz < Math.min(az, bz) - pad || pz > Math.max(az, bz) + pad) continue;
      const dx = bx - ax;
      const dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq)) : 0;
      const d = Math.hypot(px - ax - dx * t, pz - az - dz * t) - segments[k + 4];
      if (d < best) best = Math.max(0, d);
    }
    return best;
  }

  return function floorAt(px, pz) {
    const gx = (px / widthMeters + x) / forestScale;
    const gy = (pz / heightMeters + y) / forestScale;
    let inForest = false;
    for (const f of features) {
      if (px < f.minX || px > f.maxX || pz < f.minZ || pz > f.maxZ) continue;
      if (inFeature(gx, gy, f)) {
        inForest = true;
        break;
      }
    }
    if (!inForest) return 0;
    const s = Math.min(1, Math.max(0, (roadDistance(px, pz) - FOREST_FLOOR_ROAD_GAP_M) / FADE_METERS));
    if (s <= 0) return 0;
    // Global DETAIL tile units: the same at a shared edge from either tile.
    const u = px / widthMeters + x;
    const v = pz / heightMeters + y;
    let n = 0;
    for (const [perTile, weight] of NOISE_OCTAVES) n += valueNoise(u * perTile, v * perTile) * weight;
    return (n / NOISE_NORM) * FOREST_FLOOR_NOISE_M * s * s * (3 - 2 * s);
  };
}
