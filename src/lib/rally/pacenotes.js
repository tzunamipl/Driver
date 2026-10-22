// Pacenote generator (editor): the stage's road line (stageRoute.js) resampled, its heading
// smoothed, corners found where curvature stays up, each graded by an effective radius -
// the tightest radius plus what cutting across the road's width gains over the corner's angle,
// so shallow kinks come out fast. Junctions where the stage leaves the obvious road are marked.
// Each note carries where the HUD shows it (SHOW_M before the corner) and hides it (its apex).
// Note format: pacenoteCalls.js.

import { localToLatLon, latLonToLocal } from '../geo.js';
import { routeStage } from './stageRoute.js';

const STEP_M = 2;
const SMOOTH_SIGMA_M = 8; // OSM roads are polygons: heading changes spread over this
const ENTER_RADIUS_M = 250; // a corner starts where the radius drops below this...
const EXIT_RADIUS_M = 400; // ...and lasts until it rises above this
const MERGE_GAP_M = 10; // same-way corners closer than this are one
const MIN_ANGLE = (12 * Math.PI) / 180;
// Width a line can use to cut a corner: a share of the mapped width (which counts shoulders), capped.
const CUT_FRACTION = 0.3;
const CUT_MAX_M = 2.4;
// Effective radius (m) below which a corner is grade 1..6 (~0.9 g); above the last: flat, no call.
const GRADE_RADII = [17, 31, 48, 77, 120, 200];
const JUNCTION_LOOK_M = 15; // branch / approach directions measured over this
const OBVIOUS_MAX = (60 * Math.PI) / 180; // a branch this far off straight on isn't the natural way
const STRAIGHT_MAX = (25 * Math.PI) / 180; // taking a branch within this of straight on: 'Straight'
const JUNCTION_CORNER_M = 20; // a corner this close to a junction gets its 'at junction'
const JUNCTION_GRADE = 6; // a turn off at a junction with no corner of its own
const SHOW_M = 100; // a note is shown this far along the road before its corner starts
const ADD_SNAP_M = 30; // an added note's spot (the car) this close to the stage road
const ADD_LOOK_M = 60; // an added note's corner: the first one starting within this past the spot

// Stage points the route goes through, in order.
const ROUTE_TYPES = new Set(['start', 'split', 'passageControl', 'finish']);

const wrap = (a) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;

/** Even samples every STEP_M along the node line: { x, z, w (road width), s }, plus each node's s. */
function resample(nodes) {
  const x = [];
  const z = [];
  const w = [];
  const nodeS = [0];
  let total = 0;
  let carry = 0; // metres into the current segment where the next sample lies
  for (let i = 0; i + 1 < nodes.length; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const width = a.links.find((l) => l.node === b)?.width ?? 6;
    while (carry <= len) {
      const t = len > 0 ? carry / len : 0;
      x.push(a.x + (b.x - a.x) * t);
      z.push(a.z + (b.z - a.z) * t);
      w.push(width);
      carry += STEP_M;
    }
    carry -= len;
    total += len;
    nodeS.push(total);
  }
  return { x, z, w, nodeS, length: total };
}

/** Signed curvature per sample (positive = right), from the smoothed heading. */
function curvature({ x, z }) {
  const n = x.length;
  const heading = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = Math.min(i, n - 2);
    const raw = Math.atan2(z[j + 1] - z[j], x[j + 1] - x[j]);
    heading[i] = i ? heading[i - 1] + wrap(raw - heading[i - 1]) : raw;
  }
  const sigma = SMOOTH_SIGMA_M / STEP_M;
  const reach = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: reach * 2 + 1 }, (_, k) => Math.exp(-((k - reach) ** 2) / (2 * sigma * sigma)));
  const smooth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let weight = 0;
    for (let k = -reach; k <= reach; k++) {
      const j = Math.max(0, Math.min(n - 1, i + k));
      sum += heading[j] * kernel[k + reach];
      weight += kernel[k + reach];
    }
    smooth[i] = sum / weight;
  }
  const kappa = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) kappa[i] = (smooth[i + 1] - smooth[i - 1]) / (2 * STEP_M);
  return { kappa, heading: smooth };
}

/** Corners as sample ranges { a, b, apex (tightest sample), dir, grade | null (flat) }. */
function findCorners(samples) {
  const { kappa, heading } = curvature(samples);
  const n = kappa.length;
  const spans = [];
  for (let i = 0; i < n; i++) {
    if (Math.abs(kappa[i]) < 1 / ENTER_RADIUS_M) continue;
    const sign = Math.sign(kappa[i]);
    let a = i;
    while (a > 0 && kappa[a - 1] * sign > 1 / EXIT_RADIUS_M) a--;
    let b = i;
    while (b < n - 1 && kappa[b + 1] * sign > 1 / EXIT_RADIUS_M) b++;
    const last = spans[spans.length - 1];
    if (last && last.sign === sign && (a - last.b) * STEP_M < MERGE_GAP_M) last.b = b;
    else spans.push({ a, b, sign });
    i = b;
  }
  const corners = [];
  for (const { a, b, sign } of spans) {
    const angle = Math.abs(heading[b] - heading[a]);
    if (angle < MIN_ANGLE) continue;
    let peak = 0;
    let apex = a;
    let width = Infinity;
    for (let i = a; i <= b; i++) {
      if (Math.abs(kappa[i]) > peak) {
        peak = Math.abs(kappa[i]);
        apex = i;
      }
      width = Math.min(width, samples.w[i]);
    }
    const half = Math.min(angle, Math.PI) / 2;
    const radius = 1 / peak + Math.min(width * CUT_FRACTION, CUT_MAX_M) / (1 - Math.cos(half));
    const grade = GRADE_RADII.findIndex((r) => radius < r) + 1;
    corners.push({ a, b, apex, dir: sign > 0 ? 'R' : 'L', grade: grade || null });
  }
  return corners;
}

/** Point `metres` from `node` along the branch through `next`, following unbranched road. */
function alongBranch(node, next, metres) {
  let prev = node;
  let cur = next;
  let left = metres - Math.hypot(cur.x - prev.x, cur.z - prev.z);
  while (left > 0 && cur.links.length === 2) {
    const ahead = cur.links.find((l) => l.node !== prev).node;
    prev = cur;
    cur = ahead;
    left -= Math.hypot(cur.x - prev.x, cur.z - prev.z);
  }
  return cur;
}

/** Junctions where the route leaves the obvious way: { s, turn } (signed radians, positive = right). */
function findJunctions(nodes, nodeS) {
  const junctions = [];
  for (let i = 1; i + 1 < nodes.length; i++) {
    const node = nodes[i];
    if (node.links.length < 3) continue;
    const from = nodes[i - 1];
    // Approach direction: back along the route, as far as it goes unbranched.
    const back = alongBranch(node, from, JUNCTION_LOOK_M);
    const inHeading = Math.atan2(node.z - back.z, node.x - back.x);
    const inRank = node.links.find((l) => l.node === from).rank;
    const branches = node.links
      .filter((l) => l.node !== from)
      .map((l) => {
        const p = alongBranch(node, l.node, JUNCTION_LOOK_M);
        return { link: l, turn: wrap(Math.atan2(p.z - node.z, p.x - node.x) - inHeading) };
      });
    // The natural way on: the straightest branch at least as important as the road driven, else the straightest.
    const ahead = branches.filter((b) => Math.abs(b.turn) < OBVIOUS_MAX).sort((p, q) => Math.abs(p.turn) - Math.abs(q.turn));
    const obvious = ahead.find((b) => b.link.rank <= inRank) ?? ahead[0];
    const taken = branches.find((b) => b.link.node === nodes[i + 1]);
    if (!taken || taken === obvious) continue;
    junctions.push({ s: nodeS[i], turn: taken.turn });
  }
  return junctions;
}

/** Route waypoints: start, splits and passage controls, finish. */
function routeWaypoints(points) {
  const start = points.findIndex((p) => p.type === 'start');
  const finish = points.findIndex((p) => p.type === 'finish');
  if (start < 0 || finish < start) throw new Error('Pacenotes need a start and a finish after it');
  return points
    .map((p, i) => ({ lat: p.lat, lon: p.lon, type: p.type, label: `point ${i + 1}` }))
    .slice(start, finish + 1)
    .filter((p) => ROUTE_TYPES.has(p.type));
}

const sOf = (i) => i * STEP_M;

/** The stage's road line from the start to the finish: { origin, samples, corners, routePoint }. */
async function stageLine(points, onProgress) {
  const { origin, nodes } = await routeStage(routeWaypoints(points), { onProgress });
  const samples = resample(nodes);
  const last = samples.x.length - 1;
  /** Sample i as a note's { lat, lon, s }. */
  const routePoint = (i) => {
    const j = Math.max(0, Math.min(i, last));
    const { lat, lon } = localToLatLon(samples.x[j], samples.z[j], origin.lat, origin.lon);
    return { lat, lon, s: Math.round(sOf(j)) };
  };
  return { origin, nodes, samples, corners: findCorners(samples), routePoint };
}

/** A note in the file format, from sample indices along the line. */
function noteFromSamples(routePoint, { at, apex, len, dir, grade, junction }) {
  return {
    ...routePoint(at),
    len: Math.round(len),
    dir,
    ...(dir === 'S' ? {} : { grade }),
    ...(junction ? { junction: true } : {}),
    show: routePoint(at - Math.round(SHOW_M / STEP_M)),
    apex: routePoint(apex),
  };
}

/**
 * Pacenotes for a stage's points (rally.js items, in order), from the start to the finish.
 * @param {(done: number, total: number) => void} [onProgress] - road tiles fetched.
 * @returns {Promise<{length: number, notes: object[]}>}
 */
export async function generatePacenotes(points, { onProgress } = {}) {
  const { nodes, samples, corners, routePoint } = await stageLine(points, onProgress);
  const notes = [];
  for (const j of findJunctions(nodes, samples.nodeS)) {
    const at = Math.round(j.s / STEP_M);
    if (Math.abs(j.turn) < STRAIGHT_MAX) {
      notes.push({ at, apex: at, len: 0, dir: 'S', grade: null, junction: true });
      continue;
    }
    const dir = j.turn > 0 ? 'R' : 'L';
    const near = corners
      .filter((c) => c.dir === dir && sOf(c.a) - JUNCTION_CORNER_M <= j.s && j.s <= sOf(c.b) + JUNCTION_CORNER_M)
      .sort((p, q) => Math.abs(sOf(p.a + p.b) / 2 - j.s) - Math.abs(sOf(q.a + q.b) / 2 - j.s))[0];
    if (near) near.junction = true;
    else notes.push({ at, apex: at, len: 0, dir, grade: JUNCTION_GRADE, junction: true });
  }
  for (const c of corners) {
    if (c.grade || c.junction) notes.push({ at: c.a, apex: c.apex, len: sOf(c.b - c.a), dir: c.dir, grade: c.grade ?? JUNCTION_GRADE, junction: !!c.junction });
  }
  notes.sort((p, q) => p.at - q.at);
  return { length: Math.round(samples.length), notes: notes.map((n) => noteFromSamples(routePoint, n)) };
}

/**
 * One note starting at a spot on the stage road (the car): the first corner from there (its apex,
 * direction and grade, flat ones as grade 6), else a grade 6 at the spot. Throws off the road.
 * @returns {Promise<{length: number, note: object}>} - stage length and a pacenoteCalls.js note.
 */
export async function pacenoteAt(points, lat, lon, { onProgress } = {}) {
  const { origin, samples, corners, routePoint } = await stageLine(points, onProgress);
  const spot = latLonToLocal(lat, lon, origin.lat, origin.lon);
  let at = 0;
  let best = Infinity;
  samples.x.forEach((x, i) => {
    const d = Math.hypot(x - spot.x, samples.z[i] - spot.z);
    if (d < best) {
      best = d;
      at = i;
    }
  });
  if (best > ADD_SNAP_M) throw new Error(`Drive onto the stage road first (${Math.round(best)} m off it)`);
  const corner = corners.find((c) => c.b >= at && c.a <= at + ADD_LOOK_M / STEP_M);
  const length = Math.round(samples.length);
  if (!corner) return { length, note: noteFromSamples(routePoint, { at, apex: at, len: 0, dir: 'L', grade: JUNCTION_GRADE, junction: false }) };
  const apex = Math.max(at, corner.apex);
  const fields = { at, apex, len: sOf(Math.max(0, corner.b - at)), dir: corner.dir, grade: corner.grade ?? JUNCTION_GRADE, junction: false };
  return { length, note: noteFromSamples(routePoint, fields) };
}
