// A stage version's road line saved in its stage file (`route`, `reverseRoute`) so the picker, itinerary
// and maps don't route it again: { key, length (m), points: [[lat, lon, unpaved]] } - vertices simplified
// to SIMPLIFY_M, `unpaved` (0 / 1) for the leg to the next one, `key` = the route waypoints it was routed
// through, so moved points make it stale (ignored).

import { localToLatLon } from '../geo.js';
import { routeWaypoints } from './pacenotes.js';

const SIMPLIFY_M = 1;
const COORD_DECIMALS = 6; // as the file's points: the key matches before and after a save
const round = (v) => Number(v.toFixed(COORD_DECIMALS));

/** Key of a stage version's route waypoints (its driven points, stageReverse.js); null without a start and a finish. */
export function routeKey(points) {
  let waypoints;
  try {
    waypoints = routeWaypoints(points);
  } catch {
    return null;
  }
  const text = waypoints.map((p) => `${round(p.lat)},${round(p.lon)},${p.straight ? 1 : 0}`).join(';');
  let hash = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** `route` when it was routed through these driven points, else null. */
export const savedRouteFor = (route, points) => (route && route.key === routeKey(points) ? route : null);

function offLine(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

/** Douglas-Peucker between kept nodes a and b: marks the ones to keep. */
function simplify(nodes, a, b, kept) {
  const stack = [[a, b]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let worst = SIMPLIFY_M;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = offLine(nodes[k], nodes[i], nodes[j]);
      if (d > worst) {
        worst = d;
        at = k;
      }
    }
    if (at < 0) continue;
    kept[at] = 1;
    stack.push([i, at], [at, j]);
  }
}

/** A stage line (pacenotes.js stageLine) as a saved route under `key`. */
export function encodeRoute({ origin, nodes, samples }, key) {
  const last = nodes.length - 1;
  const unpaved = (i) => (i < last && nodes[i].links.find((l) => l.node === nodes[i + 1])?.unpaved ? 1 : 0);
  const kept = new Uint8Array(nodes.length);
  kept[0] = 1;
  // Paved / unpaved changes stay vertices; each run is simplified on its own.
  let run = 0;
  for (let i = 1; i <= last; i++) {
    if (i < last && unpaved(i) === unpaved(i - 1)) continue;
    kept[i] = 1;
    simplify(nodes, run, i, kept);
    run = i;
  }
  const points = [];
  kept.forEach((keep, i) => {
    if (!keep) return;
    const { lat, lon } = localToLatLon(nodes[i].x, nodes[i].z, origin.lat, origin.lon);
    points.push([round(lat), round(lon), unpaved(i)]);
  });
  return { key, length: Math.round(samples.length), points };
}
