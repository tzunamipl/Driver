import { CRUISE_LIMITS_KMH } from '../config.js';

// Speed limit at a spot, for the cruise gearbox mode: a highway class under the car wins,
// else the built-up / open zone (also off road).

const HIGHWAY_CLASSES = new Set(['motorway', 'trunk']);
// Re-query only once the car has moved this far (metres).
const REQUERY_M = 5;

export function createSpeedLimit({ streets, builtUpAreas }) {
  let lastX = Infinity;
  let lastZ = Infinity;
  let limit = CRUISE_LIMITS_KMH.open;

  function query(x, z) {
    for (const seg of streets.segmentsAt(x, z)) {
      if (HIGHWAY_CLASSES.has(seg.style.key)) return CRUISE_LIMITS_KMH.highway;
    }
    return builtUpAreas.isBuiltUpAt(x, z) ? CRUISE_LIMITS_KMH.builtUp : CRUISE_LIMITS_KMH.open;
  }

  return {
    /** Limit (km/h) at world (x, z). */
    at(x, z) {
      if (Math.hypot(x - lastX, z - lastZ) >= REQUERY_M) {
        lastX = x;
        lastZ = z;
        limit = query(x, z);
      }
      return limit;
    },
  };
}
