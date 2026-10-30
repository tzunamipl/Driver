import { CRUISE_LIMITS_KMH, CRUISE_LIMITS_STORAGE_KEY } from '../config.js';

// Speed limit at a spot, for the cruise gearbox mode: a highway class under the car wins,
// else the built-up / open zone (also off road). Limits per zone are player settings.

const HIGHWAY_CLASSES = new Set(['motorway', 'trunk']);
// Re-query only once the car has moved this far (metres).
const REQUERY_M = 5;
const MIN_LIMIT_KMH = 10;
const MAX_LIMIT_KMH = 300;

const limits = { ...CRUISE_LIMITS_KMH, ...readLimits() };

function readLimits() {
  try {
    const saved = JSON.parse(localStorage.getItem(CRUISE_LIMITS_STORAGE_KEY) ?? '{}');
    return Object.fromEntries(Object.entries(saved).filter(([zone, kmh]) => zone in CRUISE_LIMITS_KMH && Number.isFinite(kmh)));
  } catch {
    return {};
  }
}

/** Cruise limit (km/h) per zone: { highway, open, builtUp }. */
export function getCruiseLimits() {
  return { ...limits };
}

/** Sets one zone's limit (km/h, clamped); returns the value kept. */
export function setCruiseLimit(zone, kmh) {
  if (!(zone in CRUISE_LIMITS_KMH) || !Number.isFinite(kmh)) return limits[zone];
  limits[zone] = Math.min(MAX_LIMIT_KMH, Math.max(MIN_LIMIT_KMH, kmh));
  try { localStorage.setItem(CRUISE_LIMITS_STORAGE_KEY, JSON.stringify(limits)); } catch { /* private mode */ }
  return limits[zone];
}

export function createSpeedLimit({ streets, builtUpAreas }) {
  let lastX = Infinity;
  let lastZ = Infinity;
  let zone = 'open';

  function query(x, z) {
    for (const seg of streets.segmentsAt(x, z)) {
      if (HIGHWAY_CLASSES.has(seg.style.key)) return 'highway';
    }
    return builtUpAreas.isBuiltUpAt(x, z) ? 'builtUp' : 'open';
  }

  return {
    /** Limit (km/h) at world (x, z). */
    at(x, z) {
      if (Math.hypot(x - lastX, z - lastZ) >= REQUERY_M) {
        lastX = x;
        lastZ = z;
        zone = query(x, z);
      }
      return limits[zone];
    },
  };
}
