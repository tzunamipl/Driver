// Nearest road centreline to a world point, from the streets layer's fetched segments.
// Gates sit across the road there: no stored direction, so play and editor agree.

import { latLonToLocal } from '../geo.js';

// Footpaths aren't driven; a gate snapped to one beside the road would be lost.
const SKIP_CLASSES = new Set(['path']);

const toLocal = (streets, p) => latLonToLocal(p.lat, p.lon, streets.originLat, streets.originLon, streets.scaleLat);

/**
 * @param {import('../streets.js').StreetsManager} streets
 * @returns {{x: number, z: number, dirX: number, dirZ: number, roadWidth: number, seg: object, t: number} | null}
 *   world point on the centreline, unit direction along the road, the road's stripe width,
 *   and the segment + fraction along it (for walkRoad).
 */
export function snapToRoad(streets, x, z, maxDistance) {
  let best = null;
  let bestDist = maxDistance;
  for (const seg of streets.itemsWithin(x, z, maxDistance)) {
    if (SKIP_CLASSES.has(seg.style.key)) continue;
    const a = toLocal(streets, seg.a);
    const b = toLocal(streets, seg.b);
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const lenSq = abx * abx + abz * abz;
    if (lenSq < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / lenSq));
    const px = a.x + abx * t;
    const pz = a.z + abz * t;
    const dist = Math.hypot(x - px, z - pz);
    if (dist >= bestDist) continue;
    bestDist = dist;
    const len = Math.sqrt(lenSq);
    best = { x: px, z: pz, dirX: abx / len, dirZ: abz / len, roadWidth: seg.style.linewidth, seg, t };
  }
  return best;
}

const JOIN_M = 1.5; // line ends this close are one junction
const MAX_HOPS = 20;

/** Line continuing from world point `end` (not `fromLine`), heading closest to (dirX, dirZ): { line, forward }. */
function continuation(streets, end, fromLine, dirX, dirZ) {
  let best = null;
  let bestDot = 0; // only roughly straight on
  for (const seg of streets.itemsWithin(end.x, end.z, JOIN_M)) {
    if (seg.line === fromLine || SKIP_CLASSES.has(seg.style.key)) continue;
    const { line } = seg;
    for (const forward of [true, false]) {
      const edge = forward ? line[0] : line[line.length - 1];
      const p = toLocal(streets, forward ? edge.a : edge.b);
      if (Math.hypot(p.x - end.x, p.z - end.z) > JOIN_M) continue;
      const q = toLocal(streets, forward ? edge.b : edge.a);
      const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      const dot = ((q.x - p.x) * dirX + (q.z - p.z) * dirZ) / len;
      if (dot > bestDot) {
        bestDot = dot;
        best = { line, forward };
      }
    }
  }
  return best;
}

/**
 * Follows the snapped road `metres` along it (negative: against the segment direction),
 * across junctions onto the straightest continuing road, stopping where none goes on.
 * Returns the world point and the direction of travel there.
 */
export function walkRoad(streets, snap, metres) {
  let line = snap.seg.line;
  let forward = metres >= 0;
  // Distance left to walk, from the current position along `line` in walking direction.
  let pos = snap.seg.dist + snap.seg.len * snap.t;
  let left = Math.abs(metres);
  for (let hop = 0; ; hop++) {
    const first = line[0];
    const last = line[line.length - 1];
    const room = forward ? last.dist + last.len - pos : pos - first.dist;
    const target = forward ? pos + Math.min(left, room) : pos - Math.min(left, room);
    const seg = line.find((s) => target <= s.dist + s.len) ?? last;
    const a = toLocal(streets, seg.a);
    const b = toLocal(streets, seg.b);
    const t = seg.len > 0 ? (target - seg.dist) / seg.len : 0;
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const sign = forward ? 1 : -1;
    const here = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dirX: ((b.x - a.x) / len) * sign, dirZ: ((b.z - a.z) / len) * sign };
    left -= Math.min(left, room);
    if (left <= 0 || hop >= MAX_HOPS) return here;
    const next = continuation(streets, here, line, here.dirX, here.dirZ);
    if (!next) return here;
    line = next.line;
    forward = next.forward;
    pos = forward ? line[0].dist : line[line.length - 1].dist + line[line.length - 1].len;
  }
}
