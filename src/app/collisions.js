import * as CANNON from 'cannon-es';
import { GROUND_COLLISION_GROUP } from '../lib/terrain.js';
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
 *
 * Also doubles as the "never falls underground" guard for the other way
 * this can happen: driving/teleporting to a spot where TerrainManager
 * hasn't finished streaming a chunk in yet, so there's momentarily no
 * ground body at all to tunnel through. A body with nothing under it gets
 * frozen in place instead of left to free-fall, then released and snapped
 * onto the real surface the moment a chunk loads under it and the ray
 * starts hitting again.
 */
export function createGroundTunnelGuard(world) {
  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const rayResult = new CANNON.RaycastResult();

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
      const minY = rayResult.hitPointWorld.y + MIN_GROUND_CLEARANCE;
      if (pos.y < minY) {
        // Snap back on top and kill all motion, not just downward
        // velocity - this is the same clamp whether it's catching an
        // ordinary single-step tunnel (small gap) or releasing a body
        // that's been frozen in open air below (see the no-hit branch
        // below) for however long it took a terrain chunk to stream in
        // under it (a much bigger gap) - either way it should land dead
        // still exactly on the surface, not carry residual spin/velocity
        // through the snap.
        pos.y = minY;
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
      }
      return;
    }

    // No ground within reach of the ray at all - not a one-step tunnel,
    // but a spot where no terrain chunk is loaded yet under this body
    // (e.g. a fast drive/teleport that outran TerrainManager's async
    // streaming - see mainLoop.js). Letting gravity keep integrating here
    // would have the body free-fall indefinitely with nothing to ever
    // catch it. Instead, freeze it in place (zero all motion so it just
    // hangs rather than plunging further) and keep re-casting every step;
    // once a chunk streams in underneath, the hasHit branch above fires
    // and snaps it back down onto the real surface.
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
  }

  // Multi-body rigs (e.g. the chariot's independent per-engine spheres -
  // see lib/chariot.js's `tunnelGuardBodies`) need every one of their real
  // bodies guarded individually, not just the single body other systems
  // treat as "the chassis" - otherwise the un-guarded bodies can tunnel
  // through the ground while the guarded one is caught and corrected,
  // which then fights the power-coupling springs trying to hold the two
  // apart. Falls back to just `chassisBody` for single-body rigs (cars).
  return function preventGroundTunneling(vehicle) {
    if (!vehicle) return;
    const bodies = vehicle.tunnelGuardBodies ?? [vehicle.chassisBody];
    for (const body of bodies) guardBody(body);
  };
}

/**
 * A fast, glancing hit against a building can move the chassis far enough
 * within a single physics step to skip clean through a section of the
 * solid convex-hull prism (or in through a bad corner) - the same class
 * of bug createGroundTunnelGuard patches for the terrain, applied to
 * buildings instead. Remember the chassis position right before
 * world.step() (see beforeStep), then after stepping (afterStep), sweep a
 * ray along that one step's own movement and pull the chassis back to
 * just before the wall if it crossed one, killing the velocity component
 * driving into it so the next step's normal contact resolution can take
 * over instead of immediately re-tunneling.
 *
 * Capturing "before" position immediately before every single fixed
 * substep (rather than once per render frame) is what keeps this from
 * misfiring on deliberate teleports (reset, address search): those set
 * position directly before the next world.step() call, so the only
 * movement this guard ever sees swept is that one physics step's own
 * (small, real) motion - never the teleport jump itself.
 */
export function createBuildingTunnelGuard(world) {
  // One remembered "before" position per guarded body (see
  // `vehicle.tunnelGuardBodies` below) - keyed by array index, which is
  // stable across steps for a given vehicle instance (lib/chariot.js's
  // `engineBodies` array never reorders). Reused/resized on demand rather
  // than allocated fresh every step.
  const prevPositions = [];
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

  // Sweeps a single body's own last-step movement for a building crossing
  // and pulls it back if it tunnelled through - same guard
  // createGroundTunnelGuard applies to the ground, but swept against the
  // step's own movement vector instead of a straight-down ray.
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

    // Land just short of the hit point, back off along the step's own
    // movement direction by BUILDING_SWEEP_BACKOFF_M.
    const back = Math.min(rayResult.distance, Math.max(rayResult.distance - BUILDING_SWEEP_BACKOFF_M, 0));
    const t = back / dist;
    pos.set(prevPos.x + dx * t, prevPos.y + dy * t, prevPos.z + dz * t);

    // Zero out the velocity component driving into the wall so the car
    // doesn't just immediately tunnel again next step.
    const vn = body.velocity.x * rayResult.hitNormalWorld.x +
      body.velocity.y * rayResult.hitNormalWorld.y +
      body.velocity.z * rayResult.hitNormalWorld.z;
    if (vn < 0) {
      body.velocity.x -= rayResult.hitNormalWorld.x * vn;
      body.velocity.y -= rayResult.hitNormalWorld.y * vn;
      body.velocity.z -= rayResult.hitNormalWorld.z * vn;
    }
  }

  // Multi-body rigs (the chariot's independent engine spheres) need every
  // real body swept individually - guarding only the designated
  // `chassisBody` left the other engines free to tunnel straight through
  // buildings while the guarded one got caught, and the strong
  // power-coupling springs between every engine pair (see chariot.js)
  // would then drag the corrected body back toward the tunnelled ones (or
  // vice versa), reading as "the edge engines clip through together,
  // independently of the middle one".
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
 * Catches a chassis that ends up *inside* a building's solid volume
 * instead of merely clipping through its edge - e.g. a building chunk
 * streaming in right under a car that was already parked there (building
 * data loads async, after the car/terrain), or an address-search teleport
 * landing exactly on a spot a building occupies. Rather than letting the
 * static body's own contact resolution shove the car out sideways through
 * whichever wall happens to be nearest (jarring, and can still tunnel at
 * speed), detect the overlap directly and lift the car straight up onto
 * the building's roof instead.
 *
 * Buildings are solid prisms from ground to roof (see lib/buildings.js),
 * so a ray cast straight down through the chassis' own (x, z), starting
 * from well above any real building, always hits the roof's top face
 * first - its hit height is exactly the roof's Y. If the chassis sits
 * below that (beyond a small epsilon, so a car legitimately parked flush
 * on the roof isn't mistaken for one embedded just under it), it's inside
 * the building and gets snapped up onto the roof.
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

  // See createGroundTunnelGuard/createBuildingTunnelGuard above - every
  // real body of a multi-body rig needs checking individually, not just
  // the designated `chassisBody`.
  return function preventBuildingEmbedding(vehicle) {
    if (!vehicle) return;
    const bodies = vehicle.tunnelGuardBodies ?? [vehicle.chassisBody];
    for (const body of bodies) guardBody(body);
  };
}
