import * as CANNON from 'cannon-es';
import { GROUND_COLLISION_GROUP } from './terrain.js';

// Independent ground-contact check for a single wheel, used instead of
// trusting cannon-es's own `wheel.isInContact` at face value. That flag
// comes from RaycastVehicle's internal per-wheel ray, which is short
// (suspensionRestLength + radius), skips backfaces, and travels along the
// chassis' own "down" axis - on real (uneven) terrain this can under-report
// contact even while the wheel is visibly resting on the ground. This
// instead fires a plain world-down ray from just above the wheel's actual
// world position (see car.js's wheel.worldTransform, refreshed every
// physics step) against the ground-only collision group, the same
// approach scoring.js already uses for its chassis clearance check.
const CONTACT_TOLERANCE_M = 0.08;

const rayFrom = new CANNON.Vec3();
const rayTo = new CANNON.Vec3();
const rayResult = new CANNON.RaycastResult();

export function isWheelGrounded(world, wheel) {
  const pos = wheel.worldTransform.position;
  rayFrom.set(pos.x, pos.y + wheel.radius, pos.z);
  rayTo.set(pos.x, pos.y - wheel.radius - CONTACT_TOLERANCE_M, pos.z);
  rayResult.reset();
  world.raycastClosest(rayFrom, rayTo, { collisionFilterMask: GROUND_COLLISION_GROUP }, rayResult);
  return rayResult.hasHit;
}
