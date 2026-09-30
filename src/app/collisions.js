import * as CANNON from 'cannon-es';
import { GROUND_COLLISION_GROUP } from '../lib/terrain.js';
import {
  IMPACT_ROLL_MIN_SPEED,
  IMPACT_ROLL_TORQUE_SCALE,
  GROUND_RAY_HEIGHT,
  MIN_GROUND_CLEARANCE,
} from '../config.js';

// Arcade-style collision responses layered on top of cannon-es's own
// contact resolution: (1) an impact-roll torque kick so building hits
// visibly flip/roll the car, and (2) a ground-tunneling guard that catches
// fast tumbles clipping through the terrain mesh. Kept together since both
// are "physics feel" patches applied around the raw cannon-es step.

const _impactNormal = new CANNON.Vec3();
const _impactImpulse = new CANNON.Vec3();
const _impactTorque = new CANNON.Vec3();
const _impactAngularDelta = new CANNON.Vec3();

/**
 * Turns "where on the car" (contact.ri/rj, relative to the chassis' center
 * of mass) and "how hard" (impact speed along the contact normal) into an
 * extra angular-velocity kick, so hitting a building corner off-center or
 * at speed visibly rolls/flips the car toward the side that got hit,
 * rather than the impact just stopping/deflecting it in a straight line.
 * Needed because building contacts use near-zero friction (see
 * physicsSetup.js) to let grazing hits slide - that removes the tangential
 * friction impulse that would otherwise supply most of the spin, so it's
 * added back in explicitly here instead.
 */
export function applyImpactRoll(chassisBody, contact) {
  const impactSpeed = Math.abs(contact.getImpactVelocityAlongNormal());
  if (impactSpeed < IMPACT_ROLL_MIN_SPEED) return;

  const isBi = contact.bi === chassisBody;
  // Vector from the chassis' center of mass to the actual contact point,
  // in world space - this is the "hit direction" lever arm.
  const r = isBi ? contact.ri : contact.rj;
  // The normal impulse cannon-es applies pushes bi along -ni and bj along
  // +ni (ni always points from bi to bj) - pick whichever direction
  // actually shoves the chassis, regardless of which side of the pair it
  // ended up on.
  if (isBi) contact.ni.negate(_impactNormal);
  else _impactNormal.copy(contact.ni);

  // torque = r x impulse: an off-center (large |r| perpendicular to the
  // normal) or fast hit produces a proportionally bigger torque.
  _impactNormal.scale(impactSpeed * chassisBody.mass * IMPACT_ROLL_TORQUE_SCALE, _impactImpulse);
  r.cross(_impactImpulse, _impactTorque);

  chassisBody.invInertiaWorld.vmult(_impactTorque, _impactAngularDelta);
  chassisBody.angularVelocity.vadd(_impactAngularDelta, chassisBody.angularVelocity);
}

/**
 * Fast tumbling during a flip can move the chassis box far enough in a
 * single physics step that narrowphase collision with the terrain trimesh
 * misses entirely (classic tunneling), letting the car fall through the
 * ground. As a safety net, cast a ray straight down through the chassis
 * every step and clamp it back above the terrain surface if it ever ends
 * up embedded.
 */
export function createGroundTunnelGuard(world) {
  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const rayResult = new CANNON.RaycastResult();

  return function preventGroundTunneling(vehicle) {
    if (!vehicle) return;
    const pos = vehicle.chassisBody.position;
    rayFrom.set(pos.x, pos.y + GROUND_RAY_HEIGHT, pos.z);
    rayTo.set(pos.x, pos.y - GROUND_RAY_HEIGHT, pos.z);
    rayResult.reset();
    world.raycastClosest(
      rayFrom,
      rayTo,
      { collisionFilterMask: GROUND_COLLISION_GROUP },
      rayResult
    );

    if (rayResult.hasHit) {
      const minY = rayResult.hitPointWorld.y + MIN_GROUND_CLEARANCE;
      if (pos.y < minY) {
        pos.y = minY;
        if (vehicle.chassisBody.velocity.y < 0) vehicle.chassisBody.velocity.y = 0;
      }
    }
  };
}
