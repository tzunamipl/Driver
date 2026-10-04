import * as CANNON from 'cannon-es';

// Universal air-drag model, shared by every vehicle rig (wheeled cars -
// lib/car.js - and hover pod racers - lib/chariot.js) so "how draggy does
// this particular vehicle feel moving through the air" is one small,
// reusable piece of physics instead of being reinvented per rig.
//
// A simple quadratic (speed-squared) drag force opposing the body's
// velocity - realistic air resistance grows with the *square* of speed,
// not linearly (unlike CANNON's own linearDamping, which every rig here
// already uses separately for general "settling" drag) - decomposed into
// two pieces relative to whatever world-space "forward" direction the
// caller considers the vehicle's current facing:
//   - the along-forward component, using a *different* coefficient
//     depending on whether the vehicle is moving nose-first (front) or
//     tail-first (rear) through the air - e.g. a wedge-nosed car punches
//     through the air more easily forward than it does reversing into it
//     broadside-on.
//   - everything else (side-to-side *and* up/down - "broadside" airflow,
//     which is always one combined `side` coefficient since a vehicle
//     doesn't have a separate "designed" shape for sideways or vertical
//     airflow the way it does for front/rear).
//
// Callers pass `forward` in explicitly (rather than this module reading
// body.quaternion itself) since not every rig's physics body orientation
// is a meaningful "current facing" - lib/chariot.js's independent engine
// bodies derive a shared formation heading separately from any one body's
// own quaternion (see chariot.js's computeFormationHeading) and that's
// what should be passed here, not an individual engine's quaternion.
//
// Each vehicle descriptor (see lib/vehicles/*.js) picks its own feel via
// a `dragProfile` object with three unitless multipliers on top of
// AIR_DRAG_BASE_COEFFICIENT below - vehicles with very different
// mass/thrust budgets (a wheeled car vs. a hover pod racer) are expected
// to need very different multipliers to feel right at their own top
// speed, which is exactly what per-vehicle `dragProfile` is for:
//   front - multiplier while moving nose-first through the air
//   rear  - multiplier while moving tail-first (reversing)
//   side  - multiplier for the broadside (sideways/vertical) component
export const AIR_DRAG_BASE_COEFFICIENT = 0.3; // N per (m/s)^2, before a vehicle's own front/side/rear multiplier
// Was 0.01 - calibrated back when cars had a far lighter chassis mass and
// a proportionally weaker engine force (see lib/car.js's DEFAULT_CHASSIS_MASS/
// FORCE_PER_HP history). Those were later scaled up 10x together to give
// the chassis a realistic weight without changing its acceleration feel,
// // but this coefficient was never rescaled to match - quadratic drag grows
// // with v^2, so a propulsive force 10x bigger needs ~sqrt(10) more drag per
// // unit speed^2 just to keep the same top speed, let alone actually cap it
// // at something reasonable. Left this weak, drag (plus the still-small
// rolling resistance - see wheeledVehicle.js) basically never caught up to
// the now much larger engine force before a car reached absurd (hundreds
// of m/s) velocities. Rebalanced here so cars top out in a believable
// range (see lib/vehicles/gc8.js/bigfoot.js's dragProfile for exactly what
// top speed each vehicle lands on).

// Used by any vehicle descriptor that doesn't define its own `dragProfile`
// - a generic, slightly-more-draggy-broadside-than-nose-on profile.
export const DEFAULT_DRAG_PROFILE = { front: 1, side: 2, rear: 1.15 };

const _forwardComp = new CANNON.Vec3();
const _lateral = new CANNON.Vec3();
const _force = new CANNON.Vec3();

/**
 * Applies one step's worth of directional air-drag force to `body`,
 * opposing its current velocity - `forward` must be a unit vector
 * ({x,y,z}-like, world space) representing the vehicle's current facing.
 * `dragProfile` is normally a vehicle descriptor's own `dragProfile` (see
 * lib/vehicles/*.js), falling back to DEFAULT_DRAG_PROFILE if the
 * vehicle doesn't define one.
 */
export function applyAirDrag(body, forward, dragProfile = DEFAULT_DRAG_PROFILE) {
  const v = body.velocity;
  const speedSq = v.x * v.x + v.y * v.y + v.z * v.z;
  if (speedSq < 1e-6) return;

  const alongSpeed = v.x * forward.x + v.y * forward.y + v.z * forward.z;
  _forwardComp.set(forward.x * alongSpeed, forward.y * alongSpeed, forward.z * alongSpeed);
  _lateral.set(v.x - _forwardComp.x, v.y - _forwardComp.y, v.z - _forwardComp.z);
  const lateralSpeed = _lateral.length();

  _force.set(0, 0, 0);

  if (Math.abs(alongSpeed) > 1e-6) {
    const longCoeff = (alongSpeed >= 0 ? dragProfile.front : dragProfile.rear) * AIR_DRAG_BASE_COEFFICIENT;
    // Quadratic drag (-coeff * v * |v|) directly from the signed
    // along-forward speed - sign(alongSpeed) * alongSpeed^2 == alongSpeed * |alongSpeed|,
    // and the direction to oppose is just -forward scaled by that signed speed.
    const mag = longCoeff * alongSpeed * Math.abs(alongSpeed);
    _force.x -= forward.x * mag;
    _force.y -= forward.y * mag;
    _force.z -= forward.z * mag;
  }

  if (lateralSpeed > 1e-6) {
    const sideCoeff = dragProfile.side * AIR_DRAG_BASE_COEFFICIENT;
    // Quadratic drag (-coeff * v * |v|): scaling the lateral vector
    // itself by (coeff * lateralSpeed) gives direction -unit(lateral)
    // times magnitude (coeff * lateralSpeed^2) in one step.
    const scale = sideCoeff * lateralSpeed;
    _force.x -= _lateral.x * scale;
    _force.y -= _lateral.y * scale;
    _force.z -= _lateral.z * scale;
  }

  body.applyForce(_force);
}
