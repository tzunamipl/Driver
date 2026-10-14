// Road bed for detail terrain (runs in tileWorker.js): OSM roads lift the
// ground into a slightly raised, level-across strip whose height follows
// the terrain along the centreline, blending back over a shoulder. Higher
// classes override lower ones; overlapping roads of one class share evenly.

import { fetchVectorTileLayer } from '../tiles/openFreeMap.js';
import { classifyRoad, ROAD_CLASSES, ROAD_HIERARCHY } from '../roadClasses.js';
import { sampleHeight } from './surfaceGrid.js';

const ROAD_TILE_ZOOM = 14; // the transportation layer's maxzoom
const ROAD_LIFT = 0.25; // metres above the terrain
const SHOULDER_METERS = 3; // blend from road edge back to terrain
const SUBDIVIDE_METERS = 8; // max segment length of smoothed roads, so long straights still follow the profile
const JOIN_METERS = 0.5; // line ends closer than this meet
const JOIN_MIN_STRAIGHTNESS = 0.5; // cos of the sharpest turn a road continues through a junction
// Unpaved tracks and footpaths stay part of the terrain; bridges/tunnels aren't on it.
const SKIP_CLASSES = new Set(['path', 'track']);
const SKIP_BRUNNELS = new Set(['bridge', 'tunnel']);
const CACHE_SIZE = 32;

/** Farthest a road can reach from its centreline (m). */
export const ROAD_REACH_METERS = Math.max(...Object.values(ROAD_CLASSES).map((c) => c.widthMeters)) / 2 + SHOULDER_METERS;
const MAX_SMOOTH_METERS = Math.max(...Object.values(ROAD_CLASSES).map((c) => c.smoothMeters ?? 0));
// Farthest road data (and the terrain under it) matters outside a tile: reach plus the smoothing window.
const ROAD_MARGIN_METERS = ROAD_REACH_METERS + MAX_SMOOTH_METERS / 2 + SUBDIVIDE_METERS;
/** Elevation border (px) the road bed reads outside its tile: margin + bilinear slack. */
export function roadBedBorderPx(pixelMeters) {
  return Math.ceil(ROAD_MARGIN_METERS / pixelMeters) + 2;
}

/** Class key -> priority (higher = more important); aliases rank as the class they share a style with. */
function roadPriority(key) {
  const base = ROAD_CLASSES[key.replace(/_construction$/, '')];
  return ROAD_HIERARCHY.length - ROAD_HIERARCHY.findIndex((cls) => ROAD_CLASSES[cls] === base);
}

/** Clips a flat [x, y, ...] polyline to a rectangle; returns the inside pieces. */
function clipPolyline(points, x0, y0, x1, y1) {
  const pieces = [];
  let current = null;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const ax = points[i];
    const ay = points[i + 1];
    const dx = points[i + 2] - ax;
    const dy = points[i + 3] - ay;
    // Liang-Barsky.
    let t0 = 0;
    let t1 = 1;
    const p = [-dx, dx, -dy, dy];
    const q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
    let inside = true;
    for (let k = 0; k < 4 && inside; k++) {
      if (p[k] === 0) {
        inside = q[k] >= 0;
        continue;
      }
      const r = q[k] / p[k];
      if (p[k] < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      inside = t0 < t1;
    }
    if (!inside) {
      current = null;
      continue;
    }
    if (!current || t0 > 0) {
      current = [ax + dx * t0, ay + dy * t0];
      pieces.push(current);
    }
    current.push(ax + dx * t1, ay + dy * t1);
    if (t1 < 1) current = null;
  }
  return pieces;
}

// "x/y" -> Promise<Array<{ points, halfWidth, priority, smoothMeters }>>, points flat [x, y, ...] in
// global ROAD_TILE_ZOOM tile units, clipped to the tile itself (its buffer belongs to the neighbours).
const cache = new Map();

async function decodeRoadTile(tx, ty) {
  const layer = await fetchVectorTileLayer(ROAD_TILE_ZOOM, tx, ty, 'transportation');
  const out = [];
  if (!layer) return out;
  const extent = layer.extent;
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    if (feature.type !== 2) continue; // lines only
    const props = feature.properties;
    if (SKIP_BRUNNELS.has(props.brunnel)) continue;
    const style = classifyRoad(props);
    if (!style || SKIP_CLASSES.has(style.key.replace(/_construction$/, ''))) continue;
    const info = { halfWidth: style.width / 2, priority: roadPriority(style.key), smoothMeters: style.smoothMeters };
    for (const line of feature.loadGeometry()) {
      const flat = line.flatMap((pt) => [tx + pt.x / extent, ty + pt.y / extent]);
      for (const piece of clipPolyline(flat, tx, ty, tx + 1, ty + 1)) out.push({ ...info, points: piece });
    }
  }
  return out;
}

function cachedRoadTile(tx, ty) {
  const key = `${tx}/${ty}`;
  let promise = cache.get(key);
  if (promise) {
    cache.delete(key); // re-insert as most recent
  } else {
    promise = decodeRoadTile(tx, ty);
    promise.catch(() => cache.get(key) === promise && cache.delete(key));
  }
  cache.set(key, promise);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return promise;
}

/**
 * Joins one class's line pieces into continuous strokes: ends that meet are
 * paired, straightest continuation first, so a road runs on through tile
 * edges, way splits and junctions where it doesn't turn sharply.
 */
function joinPieces(pieces) {
  const cells = new Map();
  const nodes = [];
  const nodeAt = (x, z) => {
    const cx = Math.floor(x / JOIN_METERS);
    const cz = Math.floor(z / JOIN_METERS);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const node of cells.get(`${cx + dx}/${cz + dz}`) ?? []) {
          if (Math.hypot(node.x - x, node.z - z) < JOIN_METERS) return node;
        }
      }
    }
    const node = { x, z, ends: [] };
    const key = `${cx}/${cz}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(node);
    nodes.push(node);
    return node;
  };
  // End key = piece * 2 + (0 start | 1 end); direction points into the piece.
  pieces.forEach(({ points: p }, i) => {
    const n = p.length;
    for (const [end, ex, ez, nx, nz] of [
      [0, p[0], p[1], p[2], p[3]],
      [1, p[n - 2], p[n - 1], p[n - 4], p[n - 3]],
    ]) {
      const len = Math.hypot(nx - ex, nz - ez) || 1;
      nodeAt(ex, ez).ends.push({ key: i * 2 + end, dx: (nx - ex) / len, dz: (nz - ez) / len });
    }
  });

  const partner = new Map();
  for (const { ends } of nodes) {
    if (ends.length < 2) continue;
    const pairs = [];
    for (let a = 0; a < ends.length; a++) {
      for (let b = a + 1; b < ends.length; b++) {
        const straightness = -(ends[a].dx * ends[b].dx + ends[a].dz * ends[b].dz);
        if (ends.length === 2 || straightness >= JOIN_MIN_STRAIGHTNESS) pairs.push([straightness, ends[a].key, ends[b].key]);
      }
    }
    pairs.sort((p, q) => q[0] - p[0]);
    for (const [, ka, kb] of pairs) {
      if (partner.has(ka) || partner.has(kb)) continue;
      partner.set(ka, kb);
      partner.set(kb, ka);
    }
  }

  const used = new Uint8Array(pieces.length);
  const strokes = [];
  for (let first = 0; first < pieces.length; first++) {
    if (used[first]) continue;
    // Back up to the stroke's start; `entry` = end key the walk enters a piece by.
    let entry = first * 2;
    const seen = new Set([first]);
    for (;;) {
      const prev = partner.get(entry);
      if (prev === undefined || seen.has(prev >> 1) || used[prev >> 1]) break;
      seen.add(prev >> 1);
      entry = prev ^ 1;
    }
    const points = [];
    for (;;) {
      const piece = entry >> 1;
      used[piece] = 1;
      const p = pieces[piece].points;
      const n = p.length / 2;
      for (let k = points.length ? 1 : 0; k < n; k++) {
        const v = entry & 1 ? n - 1 - k : k;
        points.push(p[v * 2], p[v * 2 + 1]);
      }
      const next = partner.get(entry ^ 1);
      if (next === undefined || used[next >> 1]) break;
      entry = next;
    }
    strokes.push({ ...pieces[first], points });
  }
  return strokes;
}

/** Splits every segment of a flat polyline into equal parts no longer than `maxLength`. */
function subdivide(points, maxLength) {
  const out = [points[0], points[1]];
  for (let i = 2; i < points.length; i += 2) {
    const ax = points[i - 2];
    const az = points[i - 1];
    const dx = points[i] - ax;
    const dz = points[i + 1] - az;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / maxLength));
    for (let k = 1; k <= n; k++) out.push(ax + (dx * k) / n, az + (dz * k) / n);
  }
  return out;
}

/**
 * Road lines around detail tile (z, x, y), in its own frame: metres from
 * the NW corner, x east (tile width `widthMeters`), z south (`heightMeters`).
 * Each is { points: [x, z, ...], halfWidth, priority, smoothMeters }; smoothed
 * classes come joined into strokes. Resolves to [] if the road tiles fail
 * (terrain still builds).
 */
export async function loadRoadLines(z, x, y, widthMeters, heightMeters) {
  const scale = 2 ** (z - ROAD_TILE_ZOOM);
  const margin = ROAD_MARGIN_METERS / widthMeters / scale; // in road tiles
  const tiles = [];
  for (let ty = Math.floor(y / scale - margin); ty <= Math.floor((y + 1) / scale + margin); ty++) {
    for (let tx = Math.floor(x / scale - margin); tx <= Math.floor((x + 1) / scale + margin); tx++) {
      tiles.push(cachedRoadTile(tx, ty));
    }
  }
  let lists;
  try {
    lists = await Promise.all(tiles);
  } catch (err) {
    console.warn('Road bed: road tiles failed, building plain terrain', z, x, y, err);
    return [];
  }
  const lines = [];
  const groups = new Map(); // smoothed lines by class, to join
  for (const list of lists) {
    for (const line of list) {
      const reach = line.halfWidth + SHOULDER_METERS + (line.smoothMeters ? line.smoothMeters / 2 + SUBDIVIDE_METERS : 0);
      // Global road tile units -> this tile's metres.
      const points = new Array(line.points.length);
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < points.length; i += 2) {
        const px = (line.points[i] * scale - x) * widthMeters;
        const pz = (line.points[i + 1] * scale - y) * heightMeters;
        points[i] = px;
        points[i + 1] = pz;
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minZ = Math.min(minZ, pz);
        maxZ = Math.max(maxZ, pz);
      }
      if (maxX < -reach || minX > widthMeters + reach || maxZ < -reach || minZ > heightMeters + reach) continue;
      const local = { ...line, points };
      if (!line.smoothMeters) {
        lines.push(local);
        continue;
      }
      const key = `${line.priority}/${line.halfWidth}/${line.smoothMeters}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(local);
    }
  }
  for (const group of groups.values()) {
    for (const stroke of joinPieces(group)) lines.push({ ...stroke, points: subdivide(stroke.points, SUBDIVIDE_METERS) });
  }
  return lines;
}

/** Per vertex: terrain averaged along the line under a tent of half-width `radius` (m). */
function smoothedHeights(points, radius, terrainAt) {
  const n = points.length / 2;
  const arc = new Float64Array(n); // arc length at each vertex
  // Per segment: midpoint arc length, length, terrain at the midpoint.
  const mid = new Float64Array(n - 1);
  const len = new Float64Array(n - 1);
  const h = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const ax = points[i * 2];
    const az = points[i * 2 + 1];
    const bx = points[i * 2 + 2];
    const bz = points[i * 2 + 3];
    len[i] = Math.hypot(bx - ax, bz - az);
    arc[i + 1] = arc[i] + len[i];
    mid[i] = arc[i] + len[i] / 2;
    h[i] = terrainAt((ax + bx) / 2, (az + bz) / 2);
  }
  const out = new Float64Array(n);
  let lo = 0;
  for (let i = 0; i < n; i++) {
    while (lo < n - 1 && mid[lo] <= arc[i] - radius) lo++;
    let sum = 0;
    let weight = 0;
    for (let j = lo; j < n - 1 && mid[j] < arc[i] + radius; j++) {
      const w = len[j] * (1 - Math.abs(mid[j] - arc[i]) / radius);
      sum += w * h[j];
      weight += w;
    }
    out[i] = weight > 0 ? sum / weight : terrainAt(points[i * 2], points[i * 2 + 1]);
  }
  return out;
}

/**
 * Height sampler for one detail tile in its own frame (see loadRoadLines):
 * `evaluateGrid` fills a regular grid with terrain + road bed. Depends only
 * on shared data, so neighbouring tiles agree along their common edge.
 * `elev` null = flat ground.
 */
export function createTileHeights({ elev, heightOffset, widthMeters, heightMeters, lines }) {
  const terrainAt = elev
    ? (x, z) => sampleHeight(elev, x / widthMeters, z / heightMeters) - heightOffset
    : () => 0;
  // Smoothed lines carry centreline heights per vertex (ha, hb); the rest follow the terrain exactly.
  const segments = [];
  for (const { points: p, halfWidth, priority, smoothMeters } of lines) {
    const heights = smoothMeters && elev ? smoothedHeights(p, smoothMeters / 2, terrainAt) : null;
    const reach = halfWidth + SHOULDER_METERS;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const [ax, az, bx, bz] = [p[i], p[i + 1], p[i + 2], p[i + 3]];
      if (Math.max(ax, bx) < -reach || Math.min(ax, bx) > widthMeters + reach) continue;
      if (Math.max(az, bz) < -reach || Math.min(az, bz) > heightMeters + reach) continue;
      segments.push({ ax, az, bx, bz, halfWidth, priority, ha: heights?.[i / 2], hb: heights?.[i / 2 + 1] });
    }
  }
  // Least important first, so each class is laid over the ones below it.
  segments.sort((a, b) => a.priority - b.priority);

  /** Heights of a cols x rows grid at (x0 + c * step, z0 + r * step), row-major. */
  function evaluateGrid(x0, z0, cols, rows, step) {
    const out = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) out[r * cols + c] = terrainAt(x0 + c * step, z0 + r * step);
    }
    if (!segments.length) return out;

    // Per node, within one priority: strongest road weight, and the weighted mean of road heights.
    const maxWeight = new Float32Array(out.length);
    const weightSum = new Float32Array(out.length);
    const targetSum = new Float32Array(out.length);
    const applyLayer = () => {
      for (let i = 0; i < out.length; i++) {
        const w = maxWeight[i];
        if (w > 0) out[i] += (targetSum[i] / weightSum[i] - out[i]) * w;
      }
      maxWeight.fill(0);
      weightSum.fill(0);
      targetSum.fill(0);
    };
    for (let k = 0; k < segments.length; k++) {
      const { ax, az, bx, bz, halfWidth, priority, ha, hb } = segments[k];
      if (k > 0 && priority !== segments[k - 1].priority) applyLayer();
      const reach = halfWidth + SHOULDER_METERS;
      const c0 = Math.max(0, Math.ceil((Math.min(ax, bx) - reach - x0) / step));
      const c1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + reach - x0) / step));
      const r0 = Math.max(0, Math.ceil((Math.min(az, bz) - reach - z0) / step));
      const r1 = Math.min(rows - 1, Math.floor((Math.max(az, bz) + reach - z0) / step));
      if (c0 > c1 || r0 > r1) continue;
      const dx = bx - ax;
      const dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      for (let r = r0; r <= r1; r++) {
        const pz = z0 + r * step;
        for (let c = c0; c <= c1; c++) {
          const px = x0 + c * step;
          const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq)) : 0;
          // Height comes from the nearest centreline point: level across the road.
          const cx = ax + dx * t;
          const cz = az + dz * t;
          const d = Math.hypot(px - cx, pz - cz);
          if (d >= reach) continue;
          let w = 1;
          if (d > halfWidth) {
            const s = (reach - d) / SHOULDER_METERS;
            w = s * s * (3 - 2 * s);
          }
          const i = r * cols + c;
          if (w > maxWeight[i]) maxWeight[i] = w;
          weightSum[i] += w;
          const base = ha === undefined ? terrainAt(cx, cz) : ha + (hb - ha) * t;
          targetSum[i] += w * (base + ROAD_LIFT);
        }
      }
    }
    applyLayer();
    return out;
  }

  return { evaluateGrid };
}
