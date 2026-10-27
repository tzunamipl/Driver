// Direction signs: arrow-shaped boards on a pole at road junctions, one pole
// per approach on the driver's right, one board per other branch naming a
// destination roughly that way with its straight-line distance. Which
// junctions get signs and what each branch points to comes from config.js
// (DIRECTION_SIGN_*). A roadside.js kind with one mesh per sign (unique text).
//
// Junctions are found per streets source tile: line ends and shared vertices
// where other signed lines pass within SNAP_M. Geometry is cached per tile;
// destinations resolve per approach once places and built-up data are loaded.

import * as THREE from 'three';
import { latLonToLocal, localToLatLon, lon2tileX, lat2tileY, tileX2lon, tileY2lat } from './geo.js';
import { ROAD_HIERARCHY } from './roadClasses.js';
import { DIRECTION_SIGN_JUNCTIONS, DIRECTION_SIGN_CITY_CLASSES_WHEN_EQUAL } from '../config.js';
import { longDistanceValue, longDistanceUnit } from './units.js';

const DEG = Math.PI / 180;
const SIGNED_CLASSES = new Set(Object.entries(DIRECTION_SIGN_JUNCTIONS).flat(2));
const CITY_WHEN_EQUAL = new Set(DIRECTION_SIGN_CITY_CLASSES_WHEN_EQUAL);
const SKIP_BRUNNELS = new Set(['bridge', 'tunnel']);

// Junction finding.
const SNAP_M = 1.5; // another line this close to a line end / shared vertex meets it there
const MERGE_M = 6; // junction points closer than this are one junction
const HASH_CELL_M = 8;
const END_EPS_M = 1; // a member this close to its line's end has no branch past it
const BRANCH_PROBE_M = 25; // branch heading = towards its point this far out
const SAME_BRANCH = 15 * DEG; // branches closer than this are one (dual carriageways)
const CLOSED_LINE_M = 1; // ends this close = a ring (roundabout): no signs there

// Placement.
const POLE_SETBACK_M = 4; // before the crossing road's edge
const POLE_EDGE_M = 1.2; // outside the approach road's edge
const POLE_PUSH_M = 2; // pushed out this much while standing on another road...
const POLE_PUSH_TRIES = 2; // ...up to this many times
const STRAIGHT_MAX = 30 * DEG; // the branch nearest straight on, if within this; the rest are left/right

// Destinations (from places.js).
const DEST_CONE = 60 * DEG; // max bearing off the branch heading
const LOCAL_MIN_M = 1000; // nearer villages are where you already are
const LOCAL_MAX_M = 25_000;
const CITY_MAX_M = 150_000;
const TOWN_FALLBACK_MAX_M = 60_000; // no city that way: the most important town
const LOCAL_CLASSES = new Set(['village', 'town']);

// Mesh.
const BOARD_H = 0.34;
const BOARD_GAP = 0.05;
const BOARD_BOTTOM = 2.0;
const BOARD_DEPTH = 0.03;
const TIP_M = 0.22;
const PAD_M = 0.08;
const MIN_BOARD_W = 1.2;
const MAX_BOARD_W = 3.2;
const PX_PER_M = 320;
const FONT_PX = 0.2 * PX_PER_M;
const POLE_RADIUS = 0.04;
const POLE_SINK = 0.1;
const HALF_HEIGHT = 1.4; // trigger box: the pole up to the boards
const DEBRIS_RADIUS = 0.1;
const MASS = 30;
const ORDER = { straight: 0, left: 1, right: 2 }; // top to bottom
const COLORS = {
  trunk: { bg: '#1c7a3c', fg: '#ffffff' },
  primary: { bg: '#1c7a3c', fg: '#ffffff' },
  secondary: { bg: '#1d4fa3', fg: '#ffffff' },
  local: { bg: '#f4f4f4', fg: '#111111' },
};

export const boardColor = (cls) => COLORS[cls] ?? COLORS.local;

const roadClass = (style) => style.key;
const rankOf = (cls) => ROAD_HIERARCHY.indexOf(cls);
const isSignedRoad = (style) => SIGNED_CLASSES.has(roadClass(style)) && !SKIP_BRUNNELS.has(style.brunnel);
const wrap = (a) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
const vertexKey = (p) => `${Math.round(p.lat * 1e7)}_${Math.round(p.lon * 1e7)}`;

function isSignedJunction(classes) {
  const ranks = classes.map(rankOf);
  const hi = ROAD_HIERARCHY[Math.min(...ranks)];
  const lo = ROAD_HIERARCHY[Math.max(...ranks)];
  return !!DIRECTION_SIGN_JUNCTIONS[hi]?.includes(lo);
}

/** Local polyline of a street line: { pts, s, length } (vertex k at s[k]). */
function linePath(line, streets) {
  const { originLat, originLon, scaleLat } = streets;
  const pts = [line[0].a, ...line.map((seg) => seg.b)].map((p) =>
    latLonToLocal(p.lat, p.lon, originLat, originLon, scaleLat)
  );
  const s = [...line.map((seg) => seg.dist), line[line.length - 1].dist + line[line.length - 1].len];
  return { pts, s, length: s[s.length - 1] };
}

/** Point at `sv` along a line: { x, z, tx, tz (unit tangent, along the line), i (piece) }. */
function pointOn(path, sv) {
  const { pts, s } = path;
  const n = pts.length - 1;
  sv = Math.max(0, Math.min(s[n], sv));
  let i = 0;
  while (i < n - 1 && s[i + 1] <= sv) i++;
  const a = pts[i];
  const b = pts[i + 1];
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const t = s[i + 1] > s[i] ? (sv - s[i]) / (s[i + 1] - s[i]) : 0;
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    tx: len > 1e-6 ? (b.x - a.x) / len : 1,
    tz: len > 1e-6 ? (b.z - a.z) / len : 0,
    i,
  };
}

/**
 * Signed junctions of one streets source tile, each with its approaches:
 * [{ lat, lon, branches: [{ line, s, dir, cls, heading }], approaches: [{ branch, sPole, seg }] }].
 * Only lat/lon and along-line distances are kept, so it survives origin shifts.
 */
function findJunctions(items, tx, ty, zoom, streets) {
  const lines = new Map(); // line -> path
  for (const item of items) {
    if (!lines.has(item.line) && isSignedRoad(item.style)) lines.set(item.line, linePath(item.line, streets));
  }
  const closed = new Set();
  const hash = new Map(); // cell -> [{ line, i }]
  const cell = (x, z) => `${Math.floor(x / HASH_CELL_M)}_${Math.floor(z / HASH_CELL_M)}`;
  const vertexLines = new Map(); // vertex key -> Set(line)
  for (const [line, { pts, length }] of lines) {
    const n = pts.length - 1;
    if (Math.hypot(pts[n].x - pts[0].x, pts[n].z - pts[0].z) < CLOSED_LINE_M && length > CLOSED_LINE_M) closed.add(line);
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const cells = new Set([cell(a.x, a.z), cell(b.x, b.z)]);
      for (const c of cells) {
        let list = hash.get(c);
        if (!list) hash.set(c, (list = []));
        list.push({ line, i });
      }
    }
    for (let k = 0; k <= n; k++) {
      const key = vertexKey(k === 0 ? line[0].a : line[k - 1].b);
      let set = vertexLines.get(key);
      if (!set) vertexLines.set(key, (set = new Set()));
      set.add(line);
    }
  }

  /** Per line within SNAP_M of (x, z): its nearest along-line distance. */
  function membersAt(x, z) {
    const best = new Map(); // line -> { d, s }
    const cx = Math.floor(x / HASH_CELL_M);
    const cz = Math.floor(z / HASH_CELL_M);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const { line, i } of hash.get(`${cx + dx}_${cz + dz}`) ?? []) {
          const { pts, s } = lines.get(line);
          const a = pts[i];
          const b = pts[i + 1];
          const abx = b.x - a.x;
          const abz = b.z - a.z;
          const lenSq = abx * abx + abz * abz;
          const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / lenSq)) : 0;
          const d = Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t));
          if (d > SNAP_M) continue;
          const prev = best.get(line);
          if (!prev || d < prev.d) best.set(line, { d, s: s[i] + (s[i + 1] - s[i]) * t });
        }
      }
    }
    return best;
  }

  // Candidate points: every line end, and vertices shared by two lines (crossings).
  const candidates = [];
  for (const [line, { pts }] of lines) {
    candidates.push(pts[0], pts[pts.length - 1]);
    for (let k = 1; k < pts.length - 1; k++) {
      if (vertexLines.get(vertexKey(line[k - 1].b)).size > 1) candidates.push(pts[k]);
    }
  }

  const { originLat, originLon, scaleLat } = streets;
  const junctions = [];
  const taken = new Map(); // MERGE_M cell -> [{ x, z }] of made junctions
  const isTaken = (p) => {
    const cx = Math.floor(p.x / MERGE_M);
    const cz = Math.floor(p.z / MERGE_M);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if ((taken.get(`${cx + dx}_${cz + dz}`) ?? []).some((q) => Math.hypot(q.x - p.x, q.z - p.z) < MERGE_M)) return true;
      }
    }
    return false;
  };
  for (const p of candidates) {
    if (isTaken(p)) continue;
    const { lat, lon } = localToLatLon(p.x, p.z, originLat, originLon, scaleLat);
    if (Math.floor(lon2tileX(lon, zoom)) !== tx || Math.floor(lat2tileY(lat, zoom)) !== ty) continue; // its own tile
    const members = membersAt(p.x, p.z);
    if (members.size < 2) continue;
    if (Array.from(members.keys()).some((line) => closed.has(line))) continue;

    let branches = [];
    for (const [line, { s }] of members) {
      const path = lines.get(line);
      for (const dir of [-1, 1]) {
        if (dir < 0 ? s < END_EPS_M : s > path.length - END_EPS_M) continue;
        const q = pointOn(path, s + dir * BRANCH_PROBE_M);
        const heading = Math.atan2(q.z - p.z, q.x - p.x);
        branches.push({ line, s, dir, cls: roadClass(line[0].style), halfWidth: line[0].style.linewidth / 2, heading });
      }
    }
    // Most important first, so a merged pair keeps the higher class.
    branches.sort((a, b) => rankOf(a.cls) - rankOf(b.cls));
    branches = branches.filter((b, k) => !branches.slice(0, k).some((o) => Math.abs(wrap(o.heading - b.heading)) < SAME_BRANCH));
    if (branches.length < 3 || !isSignedJunction(branches.map((b) => b.cls))) continue;
    const takenKey = `${Math.floor(p.x / MERGE_M)}_${Math.floor(p.z / MERGE_M)}`;
    taken.set(takenKey, [...(taken.get(takenKey) ?? []), p]);

    const junction = { lat, lon, branches, approaches: [] };
    for (const branch of branches) {
      const path = lines.get(branch.line);
      const crossing = Math.max(...branches.filter((b) => b !== branch).map((b) => b.halfWidth));
      const sPole = branch.s + branch.dir * (crossing + POLE_SETBACK_M);
      if (sPole < 0 || sPole > path.length) continue; // approach shorter than the setback
      const { i } = pointOn(path, sPole);
      junction.approaches.push({ junction, branch, sPole, seg: branch.line[i], resolved: undefined });
    }
    junctions.push(junction);
  }
  return junctions;
}

/** Places assigned to the branch nearest their bearing; per branch the best for its tier. */
function chooseDestinations(branches, places) {
  const ranks = branches.map((b) => rankOf(b.cls));
  const hiRank = Math.min(...ranks);
  const loRank = Math.max(...ranks);
  const byBranch = new Map(branches.map((b) => [b, []]));
  for (const p of places) {
    const bearing = Math.atan2(-p.north, p.east); // local x = east, z = south
    let best = null;
    let bestDiff = Infinity;
    for (const b of branches) {
      const diff = Math.abs(wrap(bearing - b.heading));
      if (diff < bestDiff) {
        bestDiff = diff;
        best = b;
      }
    }
    if (bestDiff <= DEST_CONE) byBranch.get(best).push(p);
  }
  const out = new Map();
  for (const b of branches) {
    const rank = rankOf(b.cls);
    const city = hiRank === loRank ? CITY_WHEN_EQUAL.has(b.cls) : rank < loRank;
    const list = byBranch.get(b);
    let dest;
    if (city) {
      dest = nearest(list.filter((p) => p.cls === 'city' && p.dist <= CITY_MAX_M));
      if (!dest) {
        const towns = list.filter((p) => p.cls === 'town' && p.dist <= TOWN_FALLBACK_MAX_M);
        dest = towns.sort((p, q) => p.rank - q.rank || p.dist - q.dist)[0];
      }
    } else {
      dest = nearest(list.filter((p) => LOCAL_CLASSES.has(p.cls) && p.dist >= LOCAL_MIN_M && p.dist <= LOCAL_MAX_M));
    }
    if (dest) out.set(b, dest);
  }
  return out;

  function nearest(list) {
    return list.reduce((m, p) => (!m || p.dist < m.dist ? p : m), null);
  }
}

/** Board outline (x across, y up, origin bottom centre) pointing `dir`. */
function boardShape(dir, w) {
  const h = BOARD_H;
  const l = -w / 2;
  const r = w / 2;
  const pts =
    dir === 'right'
      ? [[l, 0], [r - TIP_M, 0], [r, h / 2], [r - TIP_M, h], [l, h]]
      : dir === 'left'
        ? [[l + TIP_M, 0], [r, 0], [r, h], [l + TIP_M, h], [l, h / 2]]
        : [[l, 0], [r, 0], [r, h], [l, h]];
  return new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
}

function boardGeometry(dir, w) {
  const geometry = new THREE.ShapeGeometry(boardShape(dir, w));
  const pos = geometry.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let k = 0; k < pos.count; k++) {
    uv[k * 2] = (pos.getX(k) + w / 2) / w;
    uv[k * 2 + 1] = pos.getY(k) / BOARD_H;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

let measureCtx = null;
function textWidthM(text) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = `bold ${FONT_PX}px sans-serif`;
  return measureCtx.measureText(text).width / PX_PER_M;
}

/** Board distance: whole km or miles (lib/units.js), at least 1. */
export const kmText = (board) => `${Math.max(1, Math.round(longDistanceValue(board.km)))} ${longDistanceUnit()}`;

/** Board width fitting every board's name + distance. */
function signWidth(boards) {
  const need = Math.max(
    ...boards.map((b) => textWidthM(b.name) + textWidthM(kmText(b)) + TIP_M + 4 * PAD_M + (b.dir === 'straight' ? 0.2 : 0))
  );
  return Math.max(MIN_BOARD_W, Math.min(MAX_BOARD_W, need));
}

function boardTexture(board, w) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * PX_PER_M);
  canvas.height = Math.round(BOARD_H * PX_PER_M);
  const ctx = canvas.getContext('2d');
  const { bg, fg } = boardColor(board.cls);
  const px = (m) => m * PX_PER_M;
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  // Border following the outline (canvas y down, so the shape is drawn mirrored in y; it's symmetric).
  const inset = 6;
  const tip = px(TIP_M);
  ctx.strokeStyle = fg;
  ctx.lineWidth = 5;
  ctx.beginPath();
  if (board.dir === 'right') {
    ctx.moveTo(inset, inset);
    ctx.lineTo(W - tip, inset);
    ctx.lineTo(W - inset * 1.5, H / 2);
    ctx.lineTo(W - tip, H - inset);
    ctx.lineTo(inset, H - inset);
  } else if (board.dir === 'left') {
    ctx.moveTo(W - inset, inset);
    ctx.lineTo(tip, inset);
    ctx.lineTo(inset * 1.5, H / 2);
    ctx.lineTo(tip, H - inset);
    ctx.lineTo(W - inset, H - inset);
  } else {
    ctx.rect(inset, inset, W - 2 * inset, H - 2 * inset);
  }
  ctx.closePath();
  ctx.stroke();

  ctx.fillStyle = fg;
  ctx.font = `bold ${FONT_PX}px sans-serif`;
  ctx.textBaseline = 'middle';
  let left = px(PAD_M) + (board.dir === 'left' ? tip : 0);
  const right = W - px(PAD_M) - (board.dir === 'right' ? tip : 0);
  if (board.dir === 'straight') {
    ctx.textAlign = 'left';
    ctx.fillText('↑', left, H / 2);
    left += px(0.2);
  }
  ctx.textAlign = 'left';
  ctx.fillText(board.name, left, H / 2, Math.max(1, right - left - px(textWidthM(kmText(board)) + PAD_M)));
  ctx.textAlign = 'right';
  ctx.fillText(kmText(board), right, H / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Pole + stacked boards facing local +z, origin on the ground. */
function buildSignMesh(item) {
  const group = new THREE.Group();
  const w = signWidth(item.boards);
  const back = new THREE.MeshStandardMaterial({ color: 0x8c8c8c, roughness: 0.6, flatShading: true });
  const n = item.boards.length;
  const top = BOARD_BOTTOM + n * BOARD_H + (n - 1) * BOARD_GAP;
  item.boards.forEach((board, k) => {
    const y = top - (k + 1) * BOARD_H - k * BOARD_GAP;
    const front = new THREE.Mesh(
      boardGeometry(board.dir, w).translate(0, y, BOARD_DEPTH / 2),
      new THREE.MeshStandardMaterial({ map: boardTexture(board, w), roughness: 0.85, flatShading: true })
    );
    // Mirrored outline turned round = the same outline seen from behind.
    const mirrored = board.dir === 'left' ? 'right' : board.dir === 'right' ? 'left' : 'straight';
    const rear = new THREE.Mesh(boardGeometry(mirrored, w).rotateY(Math.PI).translate(0, y, -BOARD_DEPTH / 2), back);
    group.add(front, rear);
  });
  const poleHeight = top + POLE_SINK;
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS, poleHeight, 8).translate(
      0,
      poleHeight / 2 - POLE_SINK,
      -BOARD_DEPTH / 2 - POLE_RADIUS
    ),
    back
  );
  group.add(pole);
  group.traverse((o) => (o.castShadow = true));
  return group;
}

/**
 * @param {object} deps
 * @param {import('./streets.js').StreetsManager} deps.streets
 * @param {import('./builtUpAreas.js').BuiltUpAreasManager} deps.builtUpAreas
 * @param {ReturnType<import('./places.js').createPlaces>} deps.places
 */
export function createDirectionSignKind({ streets, builtUpAreas, places }) {
  const junctionsByTile = new WeakMap(); // source tile items -> junctions
  const approachesBySeg = new WeakMap(); // seg -> [approach], filled by indexTile
  const indexedLines = new WeakSet();

  function indexTile(lat, lon) {
    const items = streets._itemsInSourceTile(lat, lon);
    if (!items.length || junctionsByTile.has(items)) return;
    const zoom = streets.tileZoom;
    const tx = Math.floor(lon2tileX(lon, zoom));
    const ty = Math.floor(lat2tileY(lat, zoom));
    const junctions = findJunctions(items, tx, ty, zoom, streets);
    junctionsByTile.set(items, junctions);
    for (const item of items) indexedLines.add(item.line);
    for (const j of junctions) {
      for (const a of j.approaches) {
        const list = approachesBySeg.get(a.seg) ?? [];
        list.push(a);
        approachesBySeg.set(a.seg, list);
      }
    }
  }

  /** Indexes the source tile this segment's line came from (its own or a neighbour's, in the overlap). */
  function ensureIndexed(seg) {
    if (indexedLines.has(seg.line)) return;
    const lat = (seg.a.lat + seg.b.lat) / 2;
    const lon = (seg.a.lon + seg.b.lon) / 2;
    const zoom = streets.tileZoom;
    const tx = Math.floor(lon2tileX(lon, zoom));
    const ty = Math.floor(lat2tileY(lat, zoom));
    for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      indexTile(tileY2lat(ty + dy + 0.5, zoom), tileX2lon(tx + dx + 0.5, zoom));
      if (indexedLines.has(seg.line)) return;
    }
    indexedLines.add(seg.line); // not in any loaded tile: nothing to place
  }

  /** Sign for one approach: { lat, lon, yaw, boards } or false; undefined while data is loading. */
  function resolve(approach) {
    const { junction, branch, sPole } = approach;
    if (!builtUpAreas.hasDataAt(junction.lat, junction.lon)) return undefined;
    const near = places.near(junction.lat, junction.lon);
    if (!near) return undefined;
    const { originLat, originLon, scaleLat } = streets;
    const j = latLonToLocal(junction.lat, junction.lon, originLat, originLon, scaleLat);
    if (builtUpAreas.isBuiltUpAt(j.x, j.z)) return false;

    const p = pointOn(linePath(branch.line, streets), sPole);
    // Driving towards the junction, i.e. against the branch's outward direction.
    const tx = -p.tx * branch.dir;
    const tz = -p.tz * branch.dir;
    const rx = -tz; // driver's right
    const rz = tx;
    let offset = branch.halfWidth + POLE_EDGE_M;
    for (let k = 0; streets.containsPoint(p.x + rx * offset, p.z + rz * offset); k++) {
      if (k >= POLE_PUSH_TRIES) return false;
      offset += POLE_PUSH_M;
    }
    const x = p.x + rx * offset;
    const z = p.z + rz * offset;

    const travelHeading = Math.atan2(tz, tx);
    const dests = chooseDestinations(junction.branches, near);
    const others = junction.branches
      .filter((b) => b !== branch)
      .map((b) => ({ b, rel: wrap(b.heading - travelHeading) })); // rel > 0 = to the driver's right
    const ahead = others.reduce((m, o) => (Math.abs(o.rel) < Math.abs(m.rel) ? o : m));
    const boards = [];
    for (const o of others) {
      const dest = dests.get(o.b);
      if (!dest) continue;
      boards.push({
        dir: o === ahead && Math.abs(o.rel) < STRAIGHT_MAX ? 'straight' : o.rel > 0 ? 'right' : 'left',
        name: dest.name,
        km: dest.dist / 1000,
        cls: o.b.cls,
      });
    }
    if (!boards.length) return false;
    boards.sort((a, b) => ORDER[a.dir] - ORDER[b.dir]);
    const { lat, lon } = localToLatLon(x, z, originLat, originLon, scaleLat);
    // Face (local +z) the approaching driver.
    return { lat, lon, yaw: Math.atan2(-tx, -tz), boards };
  }

  function place(seg) {
    ensureIndexed(seg);
    const out = [];
    for (const approach of approachesBySeg.get(seg) ?? []) {
      if (approach.resolved === undefined) approach.resolved = resolve(approach);
      if (approach.resolved === undefined) return null;
      if (approach.resolved) out.push(approach.resolved);
    }
    return out;
  }

  const r = DEBRIS_RADIUS;
  return {
    group: 'directionSigns',
    hitSound: 'metal',
    buildMesh: buildSignMesh,
    halfExtents: { x: 0.2, y: HALF_HEIGHT, z: 0.2 },
    debrisSpheres: [
      [0, -HALF_HEIGHT + r, 0],
      [0, 0, 0],
      [-0.8, HALF_HEIGHT - r, 0],
      [0.8, HALF_HEIGHT - r, 0],
    ],
    debrisRadius: r,
    mass: MASS,
    place,
  };
}
