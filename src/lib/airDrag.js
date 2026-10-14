import * as CANNON from 'cannon-es';

// Quadratic air drag shared by all rigs, split relative to `forward`
// (passed in: hover rigs use the formation heading, not a body quaternion):
// along-forward uses `front` or `rear`, everything else uses `side`.
// Each descriptor's dragProfile multiplies AIR_DRAG_BASE_COEFFICIENT.
export const AIR_DRAG_BASE_COEFFICIENT = 0.035; // N per (m/s)^2, before a vehicle's own front/side/rear multiplier
// Balanced against the 10x mass/force rescale so cars top out at
// believable speeds (quadratic drag).

// For descriptors without a dragProfile.
export const DEFAULT_DRAG_PROFILE = { front: 1, side: 2, rear: 1.15 };

const _forwardComp = new CANNON.Vec3();
const _lateral = new CANNON.Vec3();
const _force = new CANNON.Vec3();

/** Applies one step of drag to `body`; `forward` is a world-space unit vector. */
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
    // -coeff * v * |v| along forward.
    const mag = longCoeff * alongSpeed * Math.abs(alongSpeed);
    _force.x -= forward.x * mag;
    _force.y -= forward.y * mag;
    _force.z -= forward.z * mag;
  }

  if (lateralSpeed > 1e-6) {
    const sideCoeff = dragProfile.side * AIR_DRAG_BASE_COEFFICIENT;
    // Same for the lateral component, in one scale.
    const scale = sideCoeff * lateralSpeed;
    _force.x -= _lateral.x * scale;
    _force.y -= _lateral.y * scale;
    _force.z -= _lateral.z * scale;
  }

  body.applyForce(_force);
}
