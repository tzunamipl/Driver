// Nearest road centreline to a world point, from the streets layer's fetched segments.
// Gates sit across the road there: no stored direction, so play and editor agree.

import { latLonToLocal } from '../geo.js';

// Footpaths aren't driven; a gate snapped to one beside the road would be lost.
const SKIP_CLASSES = new Set(['path']);

/**
 * @param {import('../streets.js').StreetsManager} streets
 * @returns {{x: number, z: number, dirX: number, dirZ: number, roadWidth: number} | null}
 *   world point on the centreline, unit direction along the road, the road's stripe width.
 */
export function snapToRoad(streets, x, z, maxDistance) {
  let best = null;
  let bestDist = maxDistance;
  for (const seg of streets.itemsWithin(x, z, maxDistance)) {
    if (SKIP_CLASSES.has(seg.style.key)) continue;
    const a = latLonToLocal(seg.a.lat, seg.a.lon, streets.originLat, streets.originLon, streets.scaleLat);
    const b = latLonToLocal(seg.b.lat, seg.b.lon, streets.originLat, streets.originLon, streets.scaleLat);
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
    best = { x: px, z: pz, dirX: abx / len, dirZ: abz / len, roadWidth: seg.style.linewidth };
  }
  return best;
}
