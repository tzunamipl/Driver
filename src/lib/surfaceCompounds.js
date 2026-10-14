// Tyre grip per ground surface (classified in terrainSurface.js), applied
// in wheeledVehicle.js's applyFriction on top of each vehicle's own tuning:
//   effectiveFrictionSlip = frictionSlip * frictionMultiplier + frictionSlipOffset
//   maxGrip = min(suspensionForce * effectiveFrictionSlip, maxForceN) * dt
// maxForceN is a load-independent cap (Infinity = none);
// rollingResistanceMultiplier scales the vehicle's rolling resistance.
export const SURFACE_COMPOUNDS = {
  // Paved roads: the baseline every vehicle is tuned for.
  road: { frictionMultiplier: 2.5, frictionSlipOffset: 1.0, maxForceN: Infinity, rollingResistanceMultiplier: 0.55 },
  // Everything else: slightly less grip, a bit more rolling drag.
  normal: { frictionMultiplier: 1.2, frictionSlipOffset: 0.5, maxForceN: Infinity, rollingResistanceMultiplier: 2.0 },
  // Water: very little grip, capped regardless of load, high drag.
  water: { frictionMultiplier: 1.0, frictionSlipOffset: 0.0, maxForceN: Infinity, rollingResistanceMultiplier: 8.0 },
};

// Fallback for an unset surface: off-road, not road.
export const DEFAULT_SURFACE_KEY = 'normal';

/** Compound for a surface key (unknown -> DEFAULT_SURFACE_KEY). */
export function getSurfaceCompound(key) {
  return SURFACE_COMPOUNDS[key] || SURFACE_COMPOUNDS[DEFAULT_SURFACE_KEY];
}
