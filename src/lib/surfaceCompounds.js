// Tyre "compound" presets per ground-surface type - the single place to
// retune how grip/slide differs between tarmac, open terrain and water,
// instead of that logic being buried inside wheeledVehicle.js's friction-
// circle solve. See lib/terrainSurface.js for how a wheel's (x, z) position
// is classified into one of this file's keys, and wheeledVehicle.js's
// applyFriction() for how a compound is actually applied: it scales *and*
// offsets that wheel's own base frictionSlip (car.js/vehicles/*.js -
// already tuned per vehicle, e.g. a monster truck's knobbier tyres vs. a
// rally car's sticky tarmac tyres), then clamps the resulting raw grip
// force to maxForceN, so:
//   effectiveFrictionSlip = frictionSlip * frictionMultiplier + frictionSlipOffset
//   maxGrip = min(suspensionForce * effectiveFrictionSlip, maxForceN) * dt
//
// Three independent knobs per compound:
//   - frictionMultiplier: scales the vehicle's own frictionSlip (mu) -
//     keeps each vehicle's relative tyre character intact on every
//     surface instead of flattening every vehicle to one absolute number.
//   - frictionSlipOffset: a flat +/- adjustment added *after* the
//     multiplier, so a surface can nudge every vehicle's grip the same
//     fixed amount regardless of its own base frictionSlip, independent of
//     (and on top of) the proportional multiplier above - e.g. "every
//     tyre loses a little extra bite in the wet" rather than "every tyre
//     loses the same percentage." 0 = no adjustment.
//   - maxForceN: a hard, load-independent ceiling (Newtons) on the raw
//     grip force, applied *before* the result is turned into this step's
//     impulse budget - so e.g. a heavy vehicle doesn't get proportionally
//     more traction out of a puddle just because it's pressing down
//     harder on it. Infinity = no such cap (load alone decides the limit,
//     same as before this file existed).
export const SURFACE_COMPOUNDS = {
  // Paved OSM roads (lib/terrainSurface.js/lib/streets.js) - the surface
  // every vehicle's own frictionSlip is already tuned against (see car.js's
  // "genuinely sticky tarmac rally tyre" comment), so this is left as a
  // neutral, uncapped, unadjusted baseline.
  road: { frictionMultiplier: 1.1, frictionSlipOffset: 1.4, maxForceN: Infinity },
  // Everything else (open terrain, dirt, grass, off the mapped road
  // network) - the default a wheel is classified as. Even the same tyre
  // bites a bare/unpaved surface a little less confidently than tarmac.
  normal: { frictionMultiplier: 0.8, frictionSlipOffset: 0.1, maxForceN: Infinity },
  // OSM water polygons (lib/waterAreas.js) - tyres barely bite into open
  // water at all, and what little grip remains shouldn't scale up just
  // because a heavier vehicle is pressing down harder on it, hence the
  // hard force cap stacked on top of the low multiplier. Small negative
  // offset on top of the multiplier so even high-frictionSlip vehicles
  // (sticky race tyres) still lose a bit of fixed grip in water, not just
  // a percentage of an already-high number.
  water: { frictionMultiplier: 0.3, frictionSlipOffset: -0.1, maxForceN: 5000 },
};

// Fallback compound key for an unset/unrecognized wheel.surface - "normal"
// rather than "road" since a wheel with no surface classification wired up
// yet (e.g. a brand-new vehicle rig) shouldn't silently assume it's always
// on pavement.
export const DEFAULT_SURFACE_KEY = 'normal';

/** Looks up one surface's compound, falling back to DEFAULT_SURFACE_KEY for an unset/unrecognized key. */
export function getSurfaceCompound(key) {
  return SURFACE_COMPOUNDS[key] || SURFACE_COMPOUNDS[DEFAULT_SURFACE_KEY];
}
