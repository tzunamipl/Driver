// Road bed for detail terrain (runs in tileWorker.js): OSM roads lift the
// ground into a slightly raised, level-across strip whose height follows
// the terrain along the centreline (smoothed for higher classes), with
// embankments / cuttings at set slopes back to the ground. Roads meeting at
// a junction share its height, easing to it along each road; free road ends
// run on a little, fading into the terrain. Higher classes
// override lower ones; overlapping roads of one class share evenly.

import { fetchVectorTileLayer } from '../tiles/openFreeMap.js';
import { classifyRoad, ROAD_CLASSES, ROAD_HIERARCHY } from '../roadClasses.js';
import { sampleHeight } from './surfaceGrid.js';

const ROAD_TILE_ZOOM = 14; // the transportation layer's maxzoom
const ROAD_LIFT = 0.15; // metres above the terrain
const SUBDIVIDE_METERS = 8; // max segment length of profiled roads, so long straights still follow the profile
const JOIN_METERS = 0.5; // line ends / junction vertices closer than this meet
const JOIN_MIN_STRAIGHTNESS = 0.5; // cos of the sharpest turn a road continues through a junction
const SNAP_CELL_METERS = 32; // spatial hash cell for snapping line ends onto other lines
const GRADE_WINDOW_METERS = 200; // how far along the road a max grade looks for terrain to cut / fill
const BANK_FADE_METERS = 6; // a bank still off the ground at its widest blends into it over this
const NEAREST_BLEND_METERS = 4; // a node's height blends roads whose edges are within this of its nearest one
const OVERSHOOT_METERS = 0.5; // past a vertex the road continues through, the segment hands over to the next one
// The terrain grid only has heights at its nodes, so the bed is shaped in grid cells too:
const ROAD_PAD_CELLS = 1; // road top widened by this each side, so triangles across the road don't dip to off-road nodes
const BANK_MIN_CELLS = 2; // banks span at least this, so no node jumps from road height straight to the bare ground
// Profile defaults for classes that don't set them (see roadClasses.js).
const DEFAULT_SMOOTH_METERS = 0;
const DEFAULT_MAX_GRADE = 0; // 0 = follow the terrain's grade
const DEFAULT_RAMP_METERS = 20;
const DEFAULT_BANK_METERS = 8;
const DEFAULT_FILL_SLOPE = 0.6; // 1:2 embankment
const DEFAULT_CUT_SLOPE = 0.6; // 1:1.5 cutting
// Unpaved tracks and footpaths stay part of the terrain; bridges/tunnels aren't on it.
const SKIP_CLASSES = new Set(['path', 'track']);
const SKIP_BRUNNELS = new Set(['bridge', 'tunnel']);
const CACHE_SIZE = 32;
const PROFILE_SAMPLE_METERS = 1; // debug profile lines: spacing of the terrain samples along a road

/** Road bed profile of a class key (aliases and `_construction` share their base class's). */
function roadProfile(key) {
  const def = ROAD_CLASSES[key.replace(/_construction$/, '')];
  return {
    smoothMeters: def.smoothMeters ?? DEFAULT_SMOOTH_METERS,
    maxGrade: def.maxGrade ?? DEFAULT_MAX_GRADE,
    rampMeters: def.rampMeters ?? DEFAULT_RAMP_METERS,
    bankMeters: def.bankMeters ?? DEFAULT_BANK_METERS,
    fillSlope: def.fillSlope ?? DEFAULT_FILL_SLOPE,
    cutSlope: def.cutSlope ?? DEFAULT_CUT_SLOPE,
  };
}

const bedClasses = ROAD_HIERARCHY.filter((cls) => !SKIP_CLASSES.has(cls));
const maxOf = (fn) => Math.max(...bedClasses.map(fn));
// Farthest a road can reach from its centreline (m).
const ROAD_REACH_METERS = maxOf((cls) => ROAD_CLASSES[cls].widthMeters / 2 + roadProfile(cls).bankMeters);
// Farthest road data (and the terrain under it) matters outside a tile: reach,
// plus a free end's tail, plus a junction's ramp (and its top road's half width), plus the smoothing window there.
const ROAD_MARGIN_METERS =
  ROAD_REACH_METERS +
  maxOf((cls) => tailLength(roadProfile(cls))) +
  maxOf((cls) => roadProfile(cls).rampMeters + ROAD_CLASSES[cls].widthMeters / 2) +
  maxOf((cls) => profileRadius(roadProfile(cls)) + (roadProfile(cls).maxGrade ? GRADE_WINDOW_METERS : 0)) +
  SUBDIVIDE_METERS;
/** ROAD_MARGIN_METERS plus the most the grid (cells of `cellMeters`) widens a road's reach. */
function roadMarginMeters(cellMeters) {
  return ROAD_MARGIN_METERS + (ROAD_PAD_CELLS + BANK_MIN_CELLS) * cellMeters;
}

/** Elevation border (px) the road bed samples outside its tile (grid cells of `cellMeters`): margin + bilinear slack. */
export function roadBedBorderPx(pixelMeters, cellMeters) {
  return Math.ceil(roadMarginMeters(cellMeters) / pixelMeters) + 2;
}

/** Class key -> priority (higher = more important); aliases rank as the class they share a style with. */
function roadPriority(key) {
  const base = ROAD_CLASSES[key.replace(/_construction$/, '')];
  return ROAD_HIERARCHY.length - ROAD_HIERARCHY.findIndex((cls) => ROAD_CLASSES[cls] === base);
}

/** Point clusterer: `at(x, z)` = the node within JOIN_METERS of (x, z), created if none; nodes collect `items`. */
function createNodeIndex() {
  const cells = new Map();
  const nodes = [];
  const at = (x, z) => {
    const cx = Math.floor(x / JOIN_METERS);
    const cz = Math.floor(z / JOIN_METERS);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const node of cells.get(`${cx + dx}/${cz + dz}`) ?? []) {
          if (Math.hypot(node.x - x, node.z - z) < JOIN_METERS) return node;
        }
      }
    }
    const node = { x, z, items: [] };
    const key = `${cx}/${cz}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(node);
    nodes.push(node);
    return node;
  };
  return { at, nodes };
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

// "x/y" -> Promise<Array<{ points, halfWidth, priority, ...roadProfile }>>, points flat [x, y, ...] in
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
    const info = { halfWidth: style.width / 2, priority: roadPriority(style.key), ...roadProfile(style.key) };
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
  const { at: nodeAt, nodes } = createNodeIndex();
  // End key = piece * 2 + (0 start | 1 end); direction points into the piece.
  pieces.forEach(({ points: p }, i) => {
    const n = p.length;
    for (const [end, ex, ez, nx, nz] of [
      [0, p[0], p[1], p[2], p[3]],
      [1, p[n - 2], p[n - 1], p[n - 4], p[n - 3]],
    ]) {
      const len = Math.hypot(nx - ex, nz - ez) || 1;
      nodeAt(ex, ez).items.push({ key: i * 2 + end, dx: (nx - ex) / len, dz: (nz - ez) / len });
    }
  });

  const partner = new Map();
  for (const { items: ends } of nodes) {
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

/** Splits every segment of a flat polyline into equal parts no longer than `maxLength`; `rawIndex` maps input to output vertices. */
function subdivide(points, maxLength) {
  const out = [points[0], points[1]];
  const rawIndex = [0];
  for (let i = 2; i < points.length; i += 2) {
    const ax = points[i - 2];
    const az = points[i - 1];
    const dx = points[i] - ax;
    const dz = points[i + 1] - az;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / maxLength));
    for (let k = 1; k <= n; k++) out.push(ax + (dx * k) / n, az + (dz * k) / n);
    rawIndex.push(out.length / 2 - 1);
  }
  return { points: out, rawIndex };
}

/**
 * Road lines around detail tile (z, x, y), in its own frame: metres from
 * the NW corner, x east (tile width `widthMeters`), z south (`heightMeters`).
 * Each is { points: [x, z, ...], halfWidth, priority, cutStart, cutEnd, ...roadProfile },
 * joined into strokes per class; `cut*` = that end is only where the loaded
 * road data stops, not the road's. Resolves to [] if the road tiles fail
 * (terrain still builds).
 */
export async function loadRoadLines(z, x, y, widthMeters, heightMeters, cellMeters) {
  const scale = 2 ** (z - ROAD_TILE_ZOOM);
  const reach = roadMarginMeters(cellMeters);
  // Neighbouring road tiles within the margin too, so tiles on both sides of a road tile edge build the same bed.
  const margin = reach / widthMeters / scale; // in road tiles
  const tx0 = Math.floor(x / scale - margin);
  const tx1 = Math.floor((x + 1) / scale + margin);
  const ty0 = Math.floor(y / scale - margin);
  const ty1 = Math.floor((y + 1) / scale + margin);
  const tiles = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) tiles.push(cachedRoadTile(tx, ty));
  }
  let lists;
  try {
    lists = await Promise.all(tiles);
  } catch (err) {
    console.warn('Road bed: road tiles failed, building plain terrain', z, x, y, err);
    return [];
  }
  const groups = new Map(); // lines by class, to join
  for (const list of lists) {
    for (const line of list) {
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
      const key = `${line.priority}/${line.halfWidth}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...line, points });
    }
  }
  // Loaded area in this tile's metres: ends on its edge are cuts.
  const west = (tx0 * scale - x) * widthMeters;
  const east = ((tx1 + 1) * scale - x) * widthMeters;
  const north = (ty0 * scale - y) * heightMeters;
  const south = ((ty1 + 1) * scale - y) * heightMeters;
  const isCut = (px, pz) =>
    px - west < JOIN_METERS || east - px < JOIN_METERS || pz - north < JOIN_METERS || south - pz < JOIN_METERS;
  const lines = [];
  for (const group of groups.values()) {
    for (const line of joinPieces(group)) {
      const p = line.points;
      lines.push({ ...line, cutStart: isCut(p[0], p[1]), cutEnd: isCut(p[p.length - 2], p[p.length - 1]) });
    }
  }
  return lines;
}

/**
 * Adds a vertex wherever a line's end lies on another line between its
 * vertices (a T-junction the other line wasn't split at), so junctions can
 * be matched vertex to vertex.
 */
function snapEnds(lines) {
  const cells = new Map(); // "cx/cz" -> [line, segment start index]
  lines.forEach(({ points: p }, li) => {
    for (let i = 0; i + 3 < p.length; i += 2) {
      const c0 = Math.floor((Math.min(p[i], p[i + 2]) - JOIN_METERS) / SNAP_CELL_METERS);
      const c1 = Math.floor((Math.max(p[i], p[i + 2]) + JOIN_METERS) / SNAP_CELL_METERS);
      const r0 = Math.floor((Math.min(p[i + 1], p[i + 3]) - JOIN_METERS) / SNAP_CELL_METERS);
      const r1 = Math.floor((Math.max(p[i + 1], p[i + 3]) + JOIN_METERS) / SNAP_CELL_METERS);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = `${c}/${r}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push([li, i]);
        }
      }
    }
  });
  const inserts = new Map(); // line -> [{ i, t, x, z }]
  lines.forEach(({ points: p }, li) => {
    const n = p.length;
    for (const [ex, ez] of [[p[0], p[1]], [p[n - 2], p[n - 1]]]) {
      const cell = cells.get(`${Math.floor(ex / SNAP_CELL_METERS)}/${Math.floor(ez / SNAP_CELL_METERS)}`) ?? [];
      for (const [lj, i] of cell) {
        if (lj === li) continue;
        const q = lines[lj].points;
        const dx = q[i + 2] - q[i];
        const dz = q[i + 3] - q[i + 1];
        const len = Math.hypot(dx, dz);
        if (len < 2 * JOIN_METERS) continue;
        const t = ((ex - q[i]) * dx + (ez - q[i + 1]) * dz) / (len * len);
        // Near a vertex already: the junction matching finds it.
        if (t * len < JOIN_METERS || (1 - t) * len < JOIN_METERS) continue;
        const x = q[i] + dx * t;
        const z = q[i + 1] + dz * t;
        if (Math.hypot(x - ex, z - ez) >= JOIN_METERS) continue;
        if (!inserts.has(lj)) inserts.set(lj, []);
        inserts.get(lj).push({ i, t, x, z });
      }
    }
  });
  return lines.map((line, li) => {
    const list = inserts.get(li);
    if (!list) return line;
    list.sort((a, b) => a.i - b.i || a.t - b.t);
    const p = line.points;
    const points = [];
    let k = 0;
    for (let i = 0; i < p.length; i += 2) {
      points.push(p[i], p[i + 1]);
      for (; k < list.length && list[k].i === i; k++) points.push(list[k].x, list[k].z);
    }
    return { ...line, points };
  });
}

/** Length (m) a free road end keeps levelling the ground past its end, fading out (0 for unsmoothed classes). */
function tailLength({ smoothMeters }) {
  return smoothMeters;
}

/** Tent half-width (m) a class's profile is averaged under; 0 = follows the terrain exactly. */
function profileRadius({ smoothMeters, maxGrade }) {
  return maxGrade ? Math.max(smoothMeters / 2, SUBDIVIDE_METERS) : smoothMeters / 2;
}

/**
 * Heights `h` at arc lengths `arc` held to `grade` (rise over run): the mean
 * of the lowest fill-only and highest cut-only profiles that keep it, so cut
 * and fill balance. Looks GRADE_WINDOW_METERS each way, keeping it local.
 */
function limitGrade(arc, h, grade) {
  const n = h.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let fill = h[i];
    let cut = h[i];
    for (let j = i - 1; j >= 0 && arc[i] - arc[j] <= GRADE_WINDOW_METERS; j--) {
      const slack = grade * (arc[i] - arc[j]);
      fill = Math.max(fill, h[j] - slack);
      cut = Math.min(cut, h[j] + slack);
    }
    for (let j = i + 1; j < n && arc[j] - arc[i] <= GRADE_WINDOW_METERS; j++) {
      const slack = grade * (arc[j] - arc[i]);
      fill = Math.max(fill, h[j] - slack);
      cut = Math.min(cut, h[j] + slack);
    }
    out[i] = (fill + cut) / 2;
  }
  return out;
}

/** Per vertex: terrain (held to `maxGrade` if set) averaged along the line under a tent of half-width `radius` (m). */
function smoothedHeights(points, radius, terrainAt, maxGrade) {
  const n = points.length / 2;
  const arc = new Float64Array(n); // arc length at each vertex
  // Per segment: midpoint arc length, length, terrain at the midpoint.
  const mid = new Float64Array(n - 1);
  const len = new Float64Array(n - 1);
  let h = new Float64Array(n - 1);
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
  if (maxGrade) h = limitGrade(mid, h, maxGrade);
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

/** 1 at u = 0 easing to 0 at u = 1 (smoothstep). */
function falloff(u) {
  if (u >= 1) return 0;
  return 1 - u * u * (3 - 2 * u);
}

/**
 * Per vertex at arc lengths `arc`: the correction that hits every pin
 * ({ s, d }: arc length, offset) exactly. Pins closer than two ramps are
 * joined linearly; otherwise each fades out over `ramp` metres.
 */
function pinDeltas(arc, pins, ramp) {
  pins.sort((a, b) => a.s - b.s);
  const out = new Float64Array(arc.length);
  let k = 0;
  for (let i = 0; i < arc.length; i++) {
    const s = arc[i];
    while (k < pins.length && pins[k].s <= s) k++;
    const prev = pins[k - 1];
    const next = pins[k];
    if (prev && next && next.s - prev.s <= 2 * ramp) {
      out[i] = prev.d + ((next.d - prev.d) * (s - prev.s)) / (next.s - prev.s);
    } else {
      out[i] = (prev ? prev.d * falloff((s - prev.s) / ramp) : 0) + (next ? next.d * falloff((next.s - s) / ramp) : 0);
    }
  }
  return out;
}

/** Base height of a profiled line at arc length `s` (linear between vertices). */
function baseAt({ arc, base }, s) {
  let lo = 0;
  let hi = arc.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arc[mid] <= s) lo = mid;
    else hi = mid;
  }
  const t = arc[hi] > arc[lo] ? (s - arc[lo]) / (arc[hi] - arc[lo]) : 0;
  return base[lo] + (base[hi] - base[lo]) * t;
}

/** Flat polyline run on straight past its first / last vertex by `before` / `after` metres. */
function extendEnds(p, before, after) {
  const n = p.length;
  const out = p.slice();
  for (const [len, x, z, fromX, fromZ, add] of [
    [before, p[0], p[1], p[2], p[3], (...v) => out.unshift(...v)],
    [after, p[n - 2], p[n - 1], p[n - 4], p[n - 3], (...v) => out.push(...v)],
  ]) {
    if (!len) continue;
    const l = Math.hypot(x - fromX, z - fromZ) || 1;
    add(x + ((x - fromX) / l) * len, z + ((z - fromZ) / l) * len);
  }
  return out;
}

/**
 * Centreline profiles: each line's base height (smoothed terrain, or the
 * terrain itself) gets corrected so all roads at a junction meet at one
 * height - the mean of the most important ones there. Free ends run on
 * for a tail (see tailLength) pinned to the terrain at its tip, with
 * per-vertex `fades` easing the bed out along it. Returns lines with
 * subdivided points plus per-vertex `heights` (absolute) or `deltas` (on
 * top of the terrain), or the line as is when it just follows the terrain.
 */
function buildProfiles(lines, terrainAt) {
  const snapped = snapEnds(lines);
  const { at: nodeAt, nodes } = createNodeIndex();
  snapped.forEach(({ points: p }, li) => {
    for (let r = 0; r < p.length / 2; r++) nodeAt(p[r * 2], p[r * 2 + 1]).items.push({ li, r });
  });
  // Ends meeting no other road (and not just where the loaded road data stops).
  const freeStart = new Uint8Array(snapped.length);
  const freeEnd = new Uint8Array(snapped.length);
  for (const { items } of nodes) {
    if (items.length !== 1) continue;
    const [{ li, r }] = items;
    const line = snapped[li];
    if (r === 0 && !line.cutStart) freeStart[li] = 1;
    if (r === line.points.length / 2 - 1 && !line.cutEnd) freeEnd[li] = 1;
  }

  const profiled = snapped.map((line, li) => {
    const tail = tailLength(line);
    const before = freeStart[li] ? tail : 0;
    const after = freeEnd[li] ? tail : 0;
    const { points, rawIndex } = subdivide(extendEnds(line.points, before, after), SUBDIVIDE_METERS);
    const n = points.length / 2;
    const arc = new Float64Array(n);
    for (let i = 1; i < n; i++) arc[i] = arc[i - 1] + Math.hypot(points[i * 2] - points[i * 2 - 2], points[i * 2 + 1] - points[i * 2 - 1]);
    const radius = profileRadius(line);
    const base = radius
      ? smoothedHeights(points, radius, terrainAt, line.maxGrade)
      : Float64Array.from({ length: n }, (_, i) => terrainAt(points[i * 2], points[i * 2 + 1]));
    const total = arc[n - 1];
    const fades = before || after
      ? Float64Array.from(arc, (s) => Math.min(1, before ? s / before : 1, after ? (total - s) / after : 1))
      : null;
    const pins = [];
    if (freeStart[li]) pins.push({ s: 0, d: terrainAt(points[0], points[1]) - base[0] });
    if (freeEnd[li]) pins.push({ s: total, d: terrainAt(points[n * 2 - 2], points[n * 2 - 1]) - base[n - 1] });
    // Raw vertex r sits at subdivided vertex rawIndex[r + 1] when a tail was put in front.
    const at = (r) => rawIndex[r + (before ? 1 : 0)];
    return { line, points, at, arc, base, fades, pins };
  });

  for (const { items } of nodes) {
    if (items.length < 2) continue;
    const junction = items.map(({ li, r }) => ({ p: profiled[li], i: profiled[li].at(r) }));
    const top = Math.max(...junction.map((it) => it.p.line.priority));
    let sum = 0;
    let count = 0;
    for (const { p, i } of junction) {
      if (p.line.priority !== top) continue;
      sum += p.base[i];
      count++;
    }
    const target = sum / count;
    const topHalfWidth = Math.max(...junction.filter((it) => it.p.line.priority === top).map((it) => it.p.line.halfWidth));
    for (const { p, i } of junction) {
      p.pins.push({ s: p.arc[i], d: target - p.base[i] });
      if (p.line.priority === top) continue;
      // A lower road reaches the junction height at the top road's edges, not just its centreline.
      for (const s of [p.arc[i] - topHalfWidth, p.arc[i] + topHalfWidth]) {
        if (s > 0 && s < p.arc[p.arc.length - 1]) p.pins.push({ s, d: target - baseAt(p, s) });
      }
    }
  }

  return profiled.map(({ line, points, arc, base, fades, pins }) => {
    const deltas = pins.some((pin) => Math.abs(pin.d) > 1e-3) ? pinDeltas(arc, pins, line.rampMeters) : null;
    if (profileRadius(line)) return { ...line, points, fades, heights: deltas ? base.map((h, i) => h + deltas[i]) : base };
    return deltas ? { ...line, points, deltas } : line;
  });
}

/**
 * Height sampler for one detail tile in its own frame (see loadRoadLines):
 * `evaluateGrid` fills a regular grid of `cellMeters` cells with terrain + road bed;
 * `profileLines` gives the centreline profiles for debug drawing.
 * `elev` null = flat ground.
 */
export function createTileHeights({ elev, heightOffset, widthMeters, heightMeters, cellMeters, lines }) {
  const terrainAt = elev
    ? (x, z) => sampleHeight(elev, x / widthMeters, z / heightMeters) - heightOffset
    : () => 0;
  // Centreline height per vertex: absolute (ha, hb), terrain + offset (da, db), or the terrain exactly;
  // (fa, fb) = how much of the bed applies (below 1 on a free end's tail).
  const segments = [];
  for (const line of elev ? buildProfiles(lines, terrainAt) : lines) {
    const { points: p, priority, fillSlope, cutSlope, heights, deltas, fades } = line;
    // Shaped to the grid (see ROAD_PAD_CELLS); `line` keeps the real width for the profile maths.
    const halfWidth = line.halfWidth + ROAD_PAD_CELLS * cellMeters;
    const bankMeters = Math.max(line.bankMeters, BANK_MIN_CELLS * cellMeters);
    const reach = halfWidth + bankMeters;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const [ax, az, bx, bz] = [p[i], p[i + 1], p[i + 2], p[i + 3]];
      if (Math.max(ax, bx) < -reach || Math.min(ax, bx) > widthMeters + reach) continue;
      if (Math.max(az, bz) < -reach || Math.min(az, bz) > heightMeters + reach) continue;
      segments.push({
        ax, az, bx, bz, halfWidth, priority, bankMeters, fillSlope, cutSlope, joinA: i > 0, joinB: i + 4 < p.length,
        ha: heights?.[i / 2], hb: heights?.[i / 2 + 1], da: deltas?.[i / 2], db: deltas?.[i / 2 + 1],
        fa: fades?.[i / 2] ?? 1, fb: fades?.[i / 2 + 1] ?? 1,
      });
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

    // Per node, within one priority: weighted mean of road heights, and the signed distance to the nearest road edge.
    const weightSum = new Float32Array(out.length);
    const targetSum = new Float32Array(out.length);
    const edgeDist = new Float32Array(out.length).fill(Infinity);
    const fadeSum = new Float32Array(out.length);
    // Road top inside the edges; outside, a bank at the class's slope down/up to the ground below (incl. lower roads).
    const applyLayer = ({ bankMeters, fillSlope, cutSlope }) => {
      // At least a cell, or the fade falls between nodes.
      const fade = Math.min(Math.max(BANK_FADE_METERS, step), bankMeters);
      for (let i = 0; i < out.length; i++) {
        if (!(weightSum[i] > 0)) continue;
        const g = out[i];
        const target = targetSum[i] / weightSum[i];
        const e = Math.max(0, edgeDist[i]);
        let h = target > g ? Math.max(g, target - e * fillSlope) : Math.min(g, target + e * cutSlope);
        const s = Math.min(1, (bankMeters - e) / fade);
        if (s < 1) h = g + (h - g) * s * s * (3 - 2 * s);
        const k = fadeSum[i] / weightSum[i];
        if (k < 1) h = g + (h - g) * (1 - falloff(k));
        out[i] = h;
      }
      weightSum.fill(0);
      fadeSum.fill(0);
      targetSum.fill(0);
      edgeDist.fill(Infinity);
    };
    // Signed distance past the edge (negative on the road) per node to the nearest road of the layer; heights
    // are weighted toward it, so a bend's other leg or a later stretch of the curve can't drag the road top.
    const nearBlend = Math.max(NEAREST_BLEND_METERS, 2 * step);
    const visit = (seg, accumulate) => {
      const { ax, az, bx, bz, halfWidth, bankMeters, joinA, joinB, ha, hb, da, db, fa, fb } = seg;
      const reach = halfWidth + bankMeters;
      const c0 = Math.max(0, Math.ceil((Math.min(ax, bx) - reach - x0) / step));
      const c1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + reach - x0) / step));
      const r0 = Math.max(0, Math.ceil((Math.min(az, bz) - reach - z0) / step));
      const r1 = Math.min(rows - 1, Math.floor((Math.max(az, bz) + reach - z0) / step));
      if (c0 > c1 || r0 > r1) return;
      const dx = bx - ax;
      const dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      const len = Math.sqrt(lenSq);
      for (let r = r0; r <= r1; r++) {
        const pz = z0 + r * step;
        for (let c = c0; c <= c1; c++) {
          const px = x0 + c * step;
          const tRaw = lenSq > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / lenSq : 0;
          const t = Math.max(0, Math.min(1, tRaw));
          // Height comes from the nearest centreline point: level across the road.
          const cx = ax + dx * t;
          const cz = az + dz * t;
          const eSigned = Math.hypot(px - cx, pz - cz) - halfWidth;
          const e = Math.max(0, eSigned);
          if (e >= bankMeters) continue;
          const i = r * cols + c;
          if (!accumulate) {
            if (eSigned < edgeDist[i]) edgeDist[i] = eSigned;
            continue;
          }
          const s = (bankMeters - e) / bankMeters;
          let w = s * s * (3 - 2 * s) * falloff((eSigned - edgeDist[i]) / nearBlend);
          // Caps only stand in at road ends and bends' outer wedges, else they'd terrace the profile at every vertex.
          const overshoot = tRaw < 0 ? (joinA ? -tRaw * len : 0) : tRaw > 1 ? (joinB ? (tRaw - 1) * len : 0) : 0;
          if (overshoot > 0) w /= 1 + (overshoot / OVERSHOOT_METERS) ** 2;
          if (!(w > 0)) continue;
          weightSum[i] += w;
          fadeSum[i] += w * (fa + (fb - fa) * t);
          let base;
          if (ha !== undefined) base = ha + (hb - ha) * t;
          else base = terrainAt(cx, cz) + (da === undefined ? 0 : da + (db - da) * t);
          targetSum[i] += w * (base + ROAD_LIFT);
        }
      }
    };
    for (let k0 = 0; k0 < segments.length; ) {
      let k1 = k0;
      while (k1 < segments.length && segments[k1].priority === segments[k0].priority) k1++;
      for (let k = k0; k < k1; k++) visit(segments[k], false);
      for (let k = k0; k < k1; k++) visit(segments[k], true);
      applyLayer(segments[k0]);
      k0 = k1;
    }
    return out;
  }

  /**
   * Debug: centreline profiles inside the tile as line-segment pairs
   * [x, y, z, ...]: `original` = the terrain under it, `adjusted` = the
   * road's own height (lift included, faded out along free ends' tails).
   */
  function profileLines() {
    const original = [];
    const adjusted = [];
    for (const { ax, az, bx, bz, ha, hb, da, db, fa, fb } of segments) {
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / PROFILE_SAMPLE_METERS));
      let prev = null;
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        const g = terrainAt(x, z);
        const bed = (ha !== undefined ? ha + (hb - ha) * t : g + (da === undefined ? 0 : da + (db - da) * t)) + ROAD_LIFT;
        const road = g + (bed - g) * (1 - falloff(fa + (fb - fa) * t));
        const mx = prev && (prev[0] + x) / 2;
        const mz = prev && (prev[1] + z) / 2;
        // Only the tile's own stretch, so neighbouring tiles don't draw it twice.
        if (prev && mx >= 0 && mx < widthMeters && mz >= 0 && mz < heightMeters) {
          original.push(prev[0], prev[2], prev[1], x, g, z);
          adjusted.push(prev[0], prev[3], prev[1], x, road, z);
        }
        prev = [x, z, g, road];
      }
    }
    return { original: new Float32Array(original), adjusted: new Float32Array(adjusted) };
  }

  return { evaluateGrid, profileLines };
}
