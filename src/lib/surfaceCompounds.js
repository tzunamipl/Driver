// Tyre grip per ground surface (classified in terrainSurface.js), applied
// in wheeledVehicle.js's applyFriction on top of each vehicle's own tuning:
//   staticMu  = frictionSlip * frictionMultiplier + frictionSlipOffset
//   widthGrip = (tyreWidth / REFERENCE_TYRE_WIDTH_M) ^ widthGripExponent
//   staticGrip  = min(suspensionForce * staticMu * widthGrip, maxForceN) * dt
//   dynamicGrip = staticGrip * dynamicFrictionRatio   (once the patch slides)
// maxForceN is a load-independent cap (Infinity = none);
// rollingResistanceMultiplier scales the vehicle's rolling resistance.
// widthGripExponent: >0 wide tyres grip more (lower contact pressure / floats
// on loose ground), <0 wide tyres grip less (aquaplaning).
// imperfectionCm: peak-to-peak height (cm) of the fixed pseudo-random bumps
// the suspension rays feel on this surface (surfaceImperfections.js), less
// 30% of the tyre sidewall height (wheeledVehicle.js).
export const SURFACE_COMPOUNDS = {
  // Paved roads: the baseline every vehicle is tuned for. Rubber on asphalt
  // drops off noticeably once it breaks loose.
  road: {
    frictionMultiplier: 2.5,
    frictionSlipOffset: 1.0,
    dynamicFrictionRatio: 0.7,
    widthGripExponent: 0.3,
    maxForceN: Infinity,
    rollingResistanceMultiplier: 0.55,
    imperfectionCm: 0,
  },
  // Everything else: less grip, more rolling drag; loose ground slides more evenly.
  normal: {
    frictionMultiplier: 1.2,
    frictionSlipOffset: 0.5,
    dynamicFrictionRatio: 0.85,
    widthGripExponent: 0.45,
    maxForceN: Infinity,
    rollingResistanceMultiplier: 2.0,
    imperfectionCm: 15,
  },
  // Built-up area off the road (yards, verges, lots): packed and smoother
  // than open ground, between normal and road.
  builtUp: {
    frictionMultiplier: 2.0,
    frictionSlipOffset: 0.75,
    dynamicFrictionRatio: 0.78,
    widthGripExponent: 0.35,
    maxForceN: Infinity,
    rollingResistanceMultiplier: 1.2,
    imperfectionCm: 5,
  },
  // Water: very little grip, wide tyres aquaplane. Mild rolling drag: depth
  // drag on the hull (waterDrag.js) does the real slowing.
  water: {
    frictionMultiplier: 1.0,
    frictionSlipOffset: 0.0,
    dynamicFrictionRatio: 0.9,
    widthGripExponent: -0.5,
    maxForceN: Infinity,
    rollingResistanceMultiplier: 1.5,
    imperfectionCm: 0,
  },
};

// Tyre width (m) at which width has no effect on grip (a 225 mm tyre).
export const REFERENCE_TYRE_WIDTH_M = 0.225;

// Fallback for an unset surface: off-road, not road.
export const DEFAULT_SURFACE_KEY = 'normal';

/** Compound for a surface key (unknown -> DEFAULT_SURFACE_KEY). */
export function getSurfaceCompound(key) {
  return SURFACE_COMPOUNDS[key] || SURFACE_COMPOUNDS[DEFAULT_SURFACE_KEY];
}
