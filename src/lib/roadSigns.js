// Chevron boards (red with white arrows) on the outside of sharp curves and
// hairpins: roadside.js kinds, one per tier and arrow direction. Curves are
// found per street line from the turn summed over a sliding window of road.
// Two boards per curve, one at each end, each facing the traffic driving into
// it with arrows pointing its way round; the back is plain.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { latLonToLocal, localToLatLon } from './geo.js';
import { isRoadsideRoad } from './roadside.js';
import { makeRetroreflective } from './lampGlints.js';
import { SIGN_HIT_GAIN } from './audio/postHit.js';

const DEG = Math.PI / 180;
const CURVE_WINDOW_M = 50; // road length a curve's turn is summed over; also the minimum gap between signs
const SHARP_TURN = 120 * DEG;
const HAIRPIN_TURN = 150 * DEG;
// Apex this far from either end of its line, so roundabout arcs and junction kinks don't count.
const END_CLEARANCE_M = 25;
const CLOSED_LINE_M = 1; // ends this close = a ring (roundabout)
// A board stands where this share of the curve's turn is done (entry) or left (exit)...
const ENTRY_TURN_FRACTION = 0.15;
const MIN_LEAD_M = 4; // ...but at least this far from the apex, so the two don't overlap
const VIEW_M = 30; // boards face the centreline this far back along the approach
const EDGE_OFFSET_M = 1.5; // from the stripe edge; negative = inside the road, just behind the posts
const JUNCTION_CHECK_M = 0.1; // just past the edge: another road there drops the sign

const CELL_WIDTH_M = 0.75; // one arrow
const BOARD_HEIGHT_M = 0.9;
const BOARD_BOTTOM_M = 1.0;
const BOARD_DEPTH_M = 0.04;
const POLE_WIDTH_M = 0.08;
const POLE_SINK_M = 0.1;
const DEBRIS_SPHERE_RADIUS = 0.08;
const BOARD_RED = '#d01818';
const BOARD_WHITE = '#f4f4f4';

// Face centre height and its mean colour (red with white arrows), for signGlints.js.
export const CURVE_SIGN_FACE = { y: BOARD_BOTTOM_M + BOARD_HEIGHT_M / 2, color: new THREE.Color('#e06a64') };

const TIERS = {
  sharp: { arrows: 1, poles: [0], mass: 8 },
  hairpin: { arrows: 4, poles: [-1.0, 1.0], mass: 20 },
};

/** Canvas texture of `arrows` white chevrons on red, pointing +u if `dir` > 0. */
function createBoardTexture(arrows, dir) {
  const cellW = 128;
  const h = 160;
  const canvas = document.createElement('canvas');
  canvas.width = cellW * arrows;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = BOARD_RED;
  ctx.fillRect(0, 0, canvas.width, h);
  ctx.fillStyle = BOARD_WHITE;
  const th = 0.28 * cellW;
  const top = 0.14 * h;
  const bottom = 0.86 * h;
  for (let i = 0; i < arrows; i++) {
    const x = (u) => (dir > 0 ? i * cellW + u * cellW : canvas.width - i * cellW - u * cellW);
    ctx.beginPath();
    ctx.moveTo(x(0.22), top);
    ctx.lineTo(x(0.22) + Math.sign(dir) * th, top);
    ctx.lineTo(x(0.78), h / 2);
    ctx.lineTo(x(0.22) + Math.sign(dir) * th, bottom);
    ctx.lineTo(x(0.22), bottom);
    ctx.lineTo(x(0.78) - Math.sign(dir) * th, h / 2);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = BOARD_WHITE;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, canvas.width - 6, h - 6);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Board facing +z with poles behind it; group 0 = front face, group 1 = back and poles. */
function createBoardGeometry({ arrows, poles }) {
  const width = CELL_WIDTH_M * arrows;
  const midY = BOARD_BOTTOM_M + BOARD_HEIGHT_M / 2;
  const top = BOARD_BOTTOM_M + BOARD_HEIGHT_M;
  const front = new THREE.PlaneGeometry(width, BOARD_HEIGHT_M).translate(0, midY, BOARD_DEPTH_M / 2 + 0.001);
  const parts = [new THREE.BoxGeometry(width, BOARD_HEIGHT_M, BOARD_DEPTH_M).translate(0, midY, 0)];
  const poleHeight = top + POLE_SINK_M;
  for (const px of poles) {
    parts.push(
      new THREE.BoxGeometry(POLE_WIDTH_M, poleHeight, POLE_WIDTH_M).translate(
        px,
        poleHeight / 2 - POLE_SINK_M,
        -(BOARD_DEPTH_M + POLE_WIDTH_M) / 2
      )
    );
  }
  return mergeGeometries([front, mergeGeometries(parts)], true);
}

/**
 * Curves of one street line: { path, curves: [{ tier, dir, sEntry, sExit }] }, `dir` = turn
 * sign (+1 = right, driving along the line), s = metres along the line; `path` feeds pointAt().
 */
function findCurves(line, streets) {
  const n = line.length;
  if (n < 2) return null;
  const { originLat, originLon, scaleLat } = streets;
  const pts = [line[0].a, ...line.map((seg) => seg.b)].map((p) =>
    latLonToLocal(p.lat, p.lon, originLat, originLon, scaleLat)
  );
  if (Math.hypot(pts[n].x - pts[0].x, pts[n].z - pts[0].z) < CLOSED_LINE_M) return null;
  const s = [...line.map((seg) => seg.dist), line[n - 1].dist + line[n - 1].len];

  const headings = [];
  for (let k = 0; k < n; k++) {
    const dx = pts[k + 1].x - pts[k].x;
    const dz = pts[k + 1].z - pts[k].z;
    headings.push(Math.hypot(dx, dz) > 1e-6 ? Math.atan2(dz, dx) : (headings[k - 1] ?? 0));
  }
  // turn[k] at vertex k (1..n-1), positive = towards (-dz, dx), the driver's right; prefix[k] = sum below k.
  const turn = new Float64Array(n + 1);
  const prefix = new Float64Array(n + 2);
  for (let k = 1; k < n; k++) {
    let d = headings[k] - headings[k - 1];
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
    turn[k] = d;
  }
  for (let k = 0; k <= n; k++) prefix[k + 1] = prefix[k] + turn[k];

  // Every window of road starting at a vertex: its summed turn.
  const candidates = [];
  let j = 1;
  for (let i = 1; i < n; i++) {
    if (j < i) j = i;
    while (j + 1 < n && s[j + 1] - s[i] <= CURVE_WINDOW_M) j++;
    const total = prefix[j + 1] - prefix[i];
    if (Math.abs(total) >= SHARP_TURN) candidates.push({ i, j, total });
  }
  candidates.sort((p, q) => Math.abs(q.total) - Math.abs(p.total));

  // Strongest first; one pair of signs per curve.
  const curves = [];
  const turned = (from, to) => Math.abs(prefix[to + 1] - prefix[from]); // over vertices from..to
  for (const { i, j, total } of candidates) {
    const abs = Math.abs(total);
    let k = i;
    while (k < j && turned(i, k) < abs / 2) k++;
    if (s[k] < END_CLEARANCE_M || s[n] - s[k] < END_CLEARANCE_M) continue;
    if (curves.some((c) => Math.abs(c.sApex - s[k]) < CURVE_WINDOW_M)) continue;
    let entry = i;
    while (entry < k && turned(i, entry) < abs * ENTRY_TURN_FRACTION) entry++;
    let exit = j;
    while (exit > k && turned(exit, j) < abs * ENTRY_TURN_FRACTION) exit--;
    curves.push({
      tier: abs >= HAIRPIN_TURN ? 'hairpin' : 'sharp',
      dir: Math.sign(total),
      sApex: s[k],
      sEntry: Math.min(s[entry], s[k] - MIN_LEAD_M),
      sExit: Math.max(s[exit], s[k] + MIN_LEAD_M),
    });
  }
  return { path: { line, pts, s, headings }, curves };
}

/** Centreline point at `sv` metres along the line: { x, z, tx, tz, seg } (local metres, unit tangent). */
function pointAt({ line, pts, s, headings }, sv) {
  const n = line.length;
  sv = Math.max(0, Math.min(s[n], sv));
  let m = 0;
  while (m < n - 1 && s[m + 1] <= sv) m++;
  const t = line[m].len > 1e-6 ? (sv - s[m]) / line[m].len : 0;
  return {
    x: pts[m].x + (pts[m + 1].x - pts[m].x) * t,
    z: pts[m].z + (pts[m + 1].z - pts[m].z) * t,
    tx: Math.cos(headings[m]),
    tz: Math.sin(headings[m]),
    seg: line[m],
  };
}

const hairpinSpansByLine = new WeakMap();

/** Hairpins of one street line as [sEntry, sExit] (metres along it, board to board). */
export function hairpinSpans(line, streets) {
  let spans = hairpinSpansByLine.get(line);
  if (spans) return spans;
  const found = isRoadsideRoad(line[0].style) ? findCurves(line, streets) : null;
  spans = (found?.curves ?? []).filter((c) => c.tier === 'hairpin').map((c) => [c.sEntry, c.sExit]);
  hairpinSpansByLine.set(line, spans);
  return spans;
}

/** @param {import('./streets.js').StreetsManager} streets */
export function createRoadSignKinds(streets) {
  // Line -> Map(seg -> [{ lat, lon, yaw, tier, arrow }]).
  const signsByLine = new WeakMap();

  function signsOf(line) {
    let bySeg = signsByLine.get(line);
    if (bySeg) return bySeg;
    bySeg = new Map();
    signsByLine.set(line, bySeg);
    const { style } = line[0];
    if (!isRoadsideRoad(style)) return bySeg;
    const { originLat, originLon, scaleLat } = streets;
    const halfWidth = style.linewidth / 2;
    const found = findCurves(line, streets);
    if (!found) return bySeg;
    for (const c of found.curves) {
      // travel +1 = along the line, met at the entry; -1 = against it, met at the exit.
      for (const travel of [1, -1]) {
        const p = pointAt(found.path, travel > 0 ? c.sEntry : c.sExit);
        if (p.seg.buffer) continue; // the neighbouring source tile places it
        // Outside of the curve = away from the turn.
        const ox = p.tz * c.dir;
        const oz = -p.tx * c.dir;
        const check = halfWidth + JUNCTION_CHECK_M;
        if (streets.containsPoint(p.x + ox * check, p.z + oz * check)) continue;
        const offset = halfWidth + EDGE_OFFSET_M;
        const x = p.x + ox * offset;
        const z = p.z + oz * offset;
        // Face (local +z) towards the approach; yaw maps local +z onto it.
        const view = pointAt(found.path, (travel > 0 ? c.sEntry : c.sExit) - travel * VIEW_M);
        let fx = view.x - x;
        let fz = view.z - z;
        if (Math.hypot(fx, fz) < 1e-3) {
          fx = -p.tx * travel;
          fz = -p.tz * travel;
        }
        const { lat, lon } = localToLatLon(x, z, originLat, originLon, scaleLat);
        const list = bySeg.get(p.seg) ?? [];
        // The facing driver's right is local +x, and travel * dir > 0 is a right turn for them.
        list.push({ lat, lon, yaw: Math.atan2(fx, fz), tier: c.tier, arrow: travel * c.dir });
        bySeg.set(p.seg, list);
      }
    }
    return bySeg;
  }

  const kinds = [];
  for (const [tierName, tier] of Object.entries(TIERS)) {
    const geometry = createBoardGeometry(tier);
    const back = new THREE.MeshStandardMaterial({ color: 0x8c8c8c, roughness: 0.6, flatShading: true });
    const width = CELL_WIDTH_M * tier.arrows;
    const top = BOARD_BOTTOM_M + BOARD_HEIGHT_M;
    const cy = top / 2;
    const poleZ = -(BOARD_DEPTH_M + POLE_WIDTH_M) / 2;
    const debrisSpheres = [
      ...tier.poles.map((px) => [px, -cy + DEBRIS_SPHERE_RADIUS, poleZ]),
      ...[-1, 1].flatMap((side) => [
        [(side * width) / 2, BOARD_BOTTOM_M - cy, 0],
        [(side * width) / 2, top - cy, 0],
      ]),
    ];
    for (const arrow of [1, -1]) {
      const front = makeRetroreflective(new THREE.MeshStandardMaterial({ map: createBoardTexture(tier.arrows, arrow), roughness: 0.85, flatShading: true }));
      kinds.push({
        group: 'curveSigns',
        hitSound: 'metal',
        hitGain: SIGN_HIT_GAIN,
        geometry,
        material: [front, back],
        halfExtents: { x: width / 2, y: cy, z: 0.1 },
        debrisSpheres,
        debrisRadius: DEBRIS_SPHERE_RADIUS,
        mass: tier.mass,
        place: (seg) => (signsOf(seg.line).get(seg) ?? []).filter((p) => p.tier === tierName && p.arrow === arrow),
      });
    }
  }
  return kinds;
}
