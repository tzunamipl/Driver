// Tyre grip per ground surface (classified in terrainSurface.js), applied
// in wheeledVehicle.js's applyFriction on top of each vehicle's own tuning:
//   staticMu  = frictionSlip * frictionMultiplier
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
// tyreWearMultiplier scales tread wear (abrasive gravel/rock wear faster);
// punctureMultiplier divides the rim-strike speed a tyre survives (tyres.js).
export const SURFACE_COMPOUNDS = {
  // Paved roads: the baseline every vehicle is tuned for. Rubber on asphalt
  // drops off noticeably once it breaks loose.
  road: {
    frictionMultiplier: 1.4,
    dynamicFrictionRatio: 0.8,
    widthGripExponent: 0.3,
    maxForceN: Infinity,
    rollingResistanceMultiplier: 0.55,
    imperfectionCm: 0,
    tyreWearMultiplier: 1,
    punctureMultiplier: 1,
  },
  // Unpaved roads (OSM surface=unpaved, untagged tracks/paths): packed gravel
  // or dirt - between road and open ground, slides more evenly than asphalt.
  unpaved: {
    frictionMultiplier: 0.9,
    dynamicFrictionRatio: 0.75,
    widthGripExponent: 0.4,
    maxForceN: Infinity,
    rollingResistanceMultiplier: 1.3,
    imperfectionCm: 6,
    tyreWearMultiplier: 1.3,
    punctureMultiplier: 1.15,
  },
  // Everything else: less grip, more rolling drag; loose ground slides more evenly.
  normal: {
    frictionMultiplier: 0.7,
    dynamicFrictionRatio: 0.85,
    widthGripExponent: 0.45,
    maxForceN: Infinity,
    rollingResistanceMultiplier: 2.0,
    imperfectionCm: 20,
    tyreWearMultiplier: 0.8,
    punctureMultiplier: 1,
  },
  // Built-up area off the road (yards, verges, lots): packed and smoother
  // than open ground, between normal and road.
  builtUp: {
    frictionMultiplier: 1.1,
    dynamicFrictionRatio: 0.78,
    widthGripExponent: 0.35,
    maxForceN: Infinity,
    rollingResistanceMultiplier: 1.2,
    imperfectionCm: 2,
    tyreWearMultiplier: 1,
    punctureMultiplier: 1,
  },
  // Forest floor (leaf litter, soft soil, roots): a bit less grip and more
  // drag than open ground, and rougher.
  forest: {
    frictionMultiplier: 0.6,
    dynamicFrictionRatio: 0.85,
    widthGripExponent: 0.45,
    maxForceN: Infinity,
    rollingResistanceMultiplier: 2.6,
    imperfectionCm: 30,
    tyreWearMultiplier: 0.7,
    punctureMultiplier: 1.2,
  },
  // Rock (bare rock and scree): grippy where solid, but loose scree and big
  // steps make it the roughest surface.
  rock: {
    frictionMultiplier: 0.85,
    dynamicFrictionRatio: 0.75,
    widthGripExponent: 0.3,
    maxForceN: Infinity,
    rollingResistanceMultiplier: 1.4,
    imperfectionCm: 45,
    tyreWearMultiplier: 1.8,
    punctureMultiplier: 1.4,
  },
  // Glacier ice: almost no grip, width barely matters.
  ice: {
    frictionMultiplier: 0.25,
    dynamicFrictionRatio: 0.9,
    widthGripExponent: 0.1,
    maxForceN: Infinity,
    rollingResistanceMultiplier: 0.6,
    imperfectionCm: 1,
    tyreWearMultiplier: 0.2,
    punctureMultiplier: 1,
  },
  // Scrub (bushes, brush): like open ground but draggier and rougher.
  scrub: {
    frictionMultiplier: 0.8,
    dynamicFrictionRatio: 0.85,
    widthGripExponent: 0.45,
    maxForceN: Infinity,
    rollingResistanceMultiplier: 2.8,
    imperfectionCm: 22,
    tyreWearMultiplier: 0.9,
    punctureMultiplier: 1.2,
  },
  // Sand (beach, dunes): low grip and heavy drag; wide tyres float on it.
  sand: {
    frictionMultiplier: 0.4,
    dynamicFrictionRatio: 0.95,
    widthGripExponent: 0.8,
    maxForceN: Infinity,
    rollingResistanceMultiplier: 4.0,
    imperfectionCm: 2,
    tyreWearMultiplier: 0.5,
    punctureMultiplier: 0.8,
  },
  // Water: very little grip, wide tyres aquaplane. Mild rolling drag: depth
  // drag on the hull (waterDrag.js) does the real slowing.
  water: {
    frictionMultiplier: 0.5,
    dynamicFrictionRatio: 0.9,
    widthGripExponent: -0.5,
    maxForceN: Infinity,
    rollingResistanceMultiplier: 1.5,
    imperfectionCm: 0,
    tyreWearMultiplier: 0.3,
    punctureMultiplier: 1,
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
