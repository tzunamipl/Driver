import * as CANNON from 'cannon-es';
import { GROUND_COLLISION_GROUP, GROUND_SEARCH_HEIGHT } from '../lib/terrain.js';
import { BUILDING_COLLISION_GROUP } from '../lib/buildings.js';
import {
  IMPACT_ROLL_MIN_SPEED,
  IMPACT_ROLL_TORQUE_SCALE,
  GROUND_RAY_HEIGHT,
  MIN_GROUND_CLEARANCE,
  BUILDING_SWEEP_MIN_DIST_M,
  BUILDING_SWEEP_BACKOFF_M,
  BUILDING_EMBED_RAY_HEIGHT,
  BUILDING_EMBED_EPSILON_M,
} from '../config.js';

// Arcade fixes around the cannon-es step: impact-roll torque, and guards
// against tunnelling through / ending up inside terrain and buildings.
// All guards check every body in vehicle.tunnelGuardBodies (the chariot's
// engines) or just chassisBody - guarding only one body of a spring-coupled
// rig lets the others clip through and drag it along.

// No ground at all for this long = no terrain data here (not just still
// streaming): rescue the body to the home position.
const NO_GROUND_RESCUE_STEPS = 3 * 60; // ~3 seconds at the 60Hz fixed physics step
const HOME_RESCUE_HEIGHT = 50; // dropped from above so the usual guard logic settles it onto the real surface

const _impactNormal = new CANNON.Vec3();
const _impactImpulse = new CANNON.Vec3();
const _impactTorque = new CANNON.Vec3();
const _impactAngularDelta = new CANNON.Vec3();
const _localNormal = new CANNON.Vec3();
const _localPoint = new CANNON.Vec3();
const _inverseQuat = new CANNON.Quaternion();
// A push this much along the car's -z (from ahead) on the front half counts as a nose hit.
const FRONT_HIT_MIN_ALIGN = 0.5;

/** Impact speed (m/s) of a contact on the chassis nose, pushing it backwards; 0 for any other hit. */
export function frontImpactSpeed(chassisBody, contact) {
  const isBi = contact.bi === chassisBody;
  if (isBi) contact.ni.negate(_impactNormal);
  else _impactNormal.copy(contact.ni);
  chassisBody.quaternion.conjugate(_inverseQuat);
  _inverseQuat.vmult(_impactNormal, _localNormal);
  _inverseQuat.vmult(isBi ? contact.ri : contact.rj, _localPoint);
  if (_localPoint.z <= 0 || _localNormal.z > -FRONT_HIT_MIN_ALIGN) return 0;
  return Math.abs(contact.getImpactVelocityAlongNormal());
}

/**
 * Adds an angular-velocity kick from an impact (lever arm x impact speed)
 * so off-centre building hits roll/flip the car. Needed because building
 * contacts are near-frictionless (physicsSetup.js), which removes most of
 * the natural spin.
 */
export function applyImpactRoll(chassisBody, contact) {
  const impactSpeed = Math.abs(contact.getImpactVelocityAlongNormal());
  if (impactSpeed < IMPACT_ROLL_MIN_SPEED) return;

  const isBi = contact.bi === chassisBody;
  const r = isBi ? contact.ri : contact.rj; // centre of mass -> contact point
  // ni points from bi to bj; take the direction that pushes the chassis.
  if (isBi) contact.ni.negate(_impactNormal);
  else _impactNormal.copy(contact.ni);

  _impactNormal.scale(impactSpeed * chassisBody.mass * IMPACT_ROLL_TORQUE_SCALE, _impactImpulse);
  r.cross(_impactImpulse, _impactTorque);

  chassisBody.invInertiaWorld.vmult(_impactTorque, _impactAngularDelta);
  chassisBody.angularVelocity.vadd(_impactAngularDelta, chassisBody.angularVelocity);
}

/**
 * Keeps bodies above the terrain each step. A short down-ray snaps a body
 * that tunnelled below the surface back on top (motion zeroed). If it
 * misses, a tall ray distinguishes:
 *  - ground above the body -> deeply embedded: snap onto it;
 *  - ground far below -> genuinely airborne: leave it alone;
 *  - nothing -> no chunk loaded yet: freeze in place, and after
 *    NO_GROUND_RESCUE_STEPS move to getHomePosition() and call onRescue().
 */
export function createGroundTunnelGuard(world, getHomePosition, onRescue) {
  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const rayResult = new CANNON.RaycastResult();
  const noGroundStreak = new WeakMap(); // body -> consecutive steps with no ground

  function guardBody(body) {
    const pos = body.position;
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
      noGroundStreak.delete(body);
      const minY = rayResult.hitPointWorld.y + MIN_GROUND_CLEARANCE;
      if (pos.y < minY) {
        pos.y = minY;
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
      }
      return;
    }

    rayFrom.set(pos.x, pos.y + GROUND_SEARCH_HEIGHT, pos.z);
    rayTo.set(pos.x, pos.y - GROUND_SEARCH_HEIGHT, pos.z);
    rayResult.reset();
    world.raycastClosest(rayFrom, rayTo, { collisionFilterMask: GROUND_COLLISION_GROUP }, rayResult);
    if (rayResult.hasHit) {
      noGroundStreak.delete(body);
      if (rayResult.hitPointWorld.y < pos.y - GROUND_RAY_HEIGHT) return; // airborne
      pos.y = rayResult.hitPointWorld.y + MIN_GROUND_CLEARANCE;
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
      return;
    }

    const streak = (noGroundStreak.get(body) ?? 0) + 1;
    if (streak > NO_GROUND_RESCUE_STEPS && getHomePosition) {
      const home = getHomePosition();
      pos.set(home.x, HOME_RESCUE_HEIGHT, home.z);
      noGroundStreak.delete(body);
      onRescue?.();
    } else {
      noGroundStreak.set(body, streak);
    }
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
  }

  return function preventGroundTunneling(vehicle) {
    if (!vehicle) return;
    const bodies = vehicle.tunnelGuardBodies ?? [vehicle.chassisBody];
    for (const body of bodies) guardBody(body);
  };
}

/**
 * Catches fast hits that skip through a building wall within one step:
 * beforeStep() records positions right before each fixed substep (so
 * teleports are never swept), afterStep() raycasts along the step's motion
 * and, on a hit, pulls the body back just short of the wall and removes
 * the velocity component into it.
 */
export function createBuildingTunnelGuard(world) {
  const prevPositions = []; // per index of tunnelGuardBodies (stable order)
  const rayResult = new CANNON.RaycastResult();
  let hasPrev = false;

  function bodiesOf(vehicle) {
    return vehicle.tunnelGuardBodies ?? [vehicle.chassisBody];
  }

  function beforeStep(vehicle) {
    if (!vehicle) {
      hasPrev = false;
      return;
    }
    const bodies = bodiesOf(vehicle);
    bodies.forEach((body, i) => {
      if (!prevPositions[i]) prevPositions[i] = new CANNON.Vec3();
      prevPositions[i].copy(body.position);
    });
    hasPrev = true;
  }

  function guardBody(body, prevPos) {
    const pos = body.position;
    const dx = pos.x - prevPos.x;
    const dy = pos.y - prevPos.y;
    const dz = pos.z - prevPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < BUILDING_SWEEP_MIN_DIST_M) return;

    rayResult.reset();
    world.raycastClosest(prevPos, pos, { collisionFilterMask: BUILDING_COLLISION_GROUP }, rayResult);
    if (!rayResult.hasHit) return;

    const back = Math.min(rayResult.distance, Math.max(rayResult.distance - BUILDING_SWEEP_BACKOFF_M, 0));
    const t = back / dist;
    pos.set(prevPos.x + dx * t, prevPos.y + dy * t, prevPos.z + dz * t);

    const vn = body.velocity.x * rayResult.hitNormalWorld.x +
      body.velocity.y * rayResult.hitNormalWorld.y +
      body.velocity.z * rayResult.hitNormalWorld.z;
    if (vn < 0) {
      body.velocity.x -= rayResult.hitNormalWorld.x * vn;
      body.velocity.y -= rayResult.hitNormalWorld.y * vn;
      body.velocity.z -= rayResult.hitNormalWorld.z * vn;
    }
  }

  function afterStep(vehicle) {
    if (!vehicle || !hasPrev) return;
    const bodies = bodiesOf(vehicle);
    bodies.forEach((body, i) => {
      const prevPos = prevPositions[i];
      if (prevPos) guardBody(body, prevPos);
    });
  }

  return { beforeStep, afterStep };
}

/**
 * Lifts a body found inside a building (e.g. a building streamed in under
 * a parked car, or a teleport onto one) onto its roof, instead of letting
 * contact resolution shove it out through a wall. Buildings are solid
 * prisms, so a down-ray from high above hits the roof first.
 */
export function createBuildingEmbedGuard(world) {
  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const rayResult = new CANNON.RaycastResult();

  function guardBody(body) {
    const pos = body.position;
    rayFrom.set(pos.x, pos.y + BUILDING_EMBED_RAY_HEIGHT, pos.z);
    rayTo.set(pos.x, pos.y - BUILDING_EMBED_RAY_HEIGHT, pos.z);
    rayResult.reset();
    world.raycastClosest(
      rayFrom,
      rayTo,
      { collisionFilterMask: BUILDING_COLLISION_GROUP },
      rayResult
    );

    if (!rayResult.hasHit) return;
    const roofY = rayResult.hitPointWorld.y;
    if (pos.y < roofY - BUILDING_EMBED_EPSILON_M) {
      pos.y = roofY + MIN_GROUND_CLEARANCE;
      if (body.velocity.y < 0) body.velocity.y = 0;
      body.angularVelocity.set(0, 0, 0);
    }
  }

  return function preventBuildingEmbedding(vehicle) {
    if (!vehicle) return;
    const bodies = vehicle.tunnelGuardBodies ?? [vehicle.chassisBody];
    for (const body of bodies) guardBody(body);
  };
}
