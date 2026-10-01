import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { MAX_FORCE, MAX_STEER } from '../config.js';
import { GROUND_COLLISION_GROUP } from './terrain.js';
import { BUILDING_COLLISION_GROUP } from './buildings.js';
import { CHASSIS_MATERIAL, createNameTag } from './vehicleShared.js';
import { ENGINE_RADIUS, POD_RADIUS, ENGINE_Z, engineLocalOffsets, POD_LOCAL_OFFSET } from './vehicles/podRacerLayout.js';
import { orientStrut } from './vehicles/podRacer.js';

// Hover/differential-thrust physics rig for "Chariots of Fire" pod-racer
// vehicles (lib/vehicles/podRacer.js) - a completely different rig from
// lib/car.js's wheeled RaycastVehicle cars, dispatched to from
// car.js's createCar/createRemoteCar whenever a vehicle descriptor has
// `vehicleType: 'hover'`. Kept in its own file per the project's "one
// file per vehicle kind, don't entangle the shared rigs" convention.
//
// How it moves, instead of wheels:
//  - Hover: every engine and the pod itself casts a ray straight down each
//    physics step; whichever one dips below HOVER_REST_HEIGHT above the
//    ground/a rooftop gets pushed back up by a spring+damper force at that
//    exact point (a simple "repulsor"), so the whole craft floats level
//    and tilts naturally over uneven ground.
//  - Thrust: each engine pushes the chassis forward along the chassis'
//    own +Z ("front") axis, applied *at that engine's own world position*
//    - so differencing left/right engine throttle doesn't need any
//    hand-written steering torque, it falls out of real physics (apply
//    more force on one side of the center of mass than the other and the
//    whole body yaws) - see computeEngineThrottles.
//  - Power couplings between neighbouring engines are visual only (rigid,
//    lib/vehicles/podRacer.js). The pod, however, is a genuinely separate
//    physics body (`podBody`) connected to the engine rig (`chassisBody`)
//    by a single inextensible "steel cable" tether (see applyTether) from
//    a central anchor point to the pod - it can go slack (the pod swings
//    freely) but is a hard, non-stretchable limit once taut (no springy
//    give), so the pod visibly lags/swings behind the engines under
//    acceleration/turns instead of being bolted on rigidly. Everything
//    still uses simple sphere hitboxes per the "simple solids for
//    graphics and hitboxes for now" brief.

const HOVER_REST_HEIGHT = 3.15;
const HOVER_MAX_RAY = HOVER_REST_HEIGHT * 3;
const HOVER_STIFFNESS = 10000; // N per metre of compression
const HOVER_DAMPING = 15; // N per (m/s) of vertical closing speed
const MAX_HOVER_FORCE = 12000;
const HOVER_RAYCAST_MASK = GROUND_COLLISION_GROUP | BUILDING_COLLISION_GROUP;

const ENGINE_THRUST_FORCE = MAX_FORCE * 10;
const LINEAR_DAMPING = 0.08;
const ANGULAR_DAMPING = 0.99;
// Car-like steering: rather than applying some force/torque that the
// physics has to react to (differential engine throttle or a direct yaw
// torque - both read as "thrust vectoring", not driving), steering here
// directly rotates the chassis' velocity vector (bends its direction,
// leaves its magnitude/speed untouched) and keeps the rig's facing in
// sync with that new direction - exactly how a simplified arcade car
// steers (the wheels redirect where the car's momentum is going, they
// don't add thrust). Rotating a near-zero velocity vector is a no-op, so
// a parked rig naturally can't spin on the spot without any extra speed
// gating being needed.
const STEER_YAW_RATE = 1.6; // rad/s the velocity vector (and facing) turns at full steer
const MIN_STEER_SPEED = 0.2; // m/s - below this, steering has no effect (avoids jitter near-zero)

// Nominal chassis "depth" used only for the rotational-inertia estimate
// below - the engines are all coplanar in Z (see podRacerLayout.js's
// engineLocalOffsets), so the real bounding depth of the engine shapes
// alone is ~0 and would make the inertia tensor degenerate on that axis.
// Deliberately generous (bigger than the engines' own footprint) so the
// rig resists the pitch/yaw torque the tether below can exert without
// becoming unstable - see tether tuning notes next to TETHER_SLACK.
const NOMINAL_CHASSIS_DEPTH = 3.2;

// --- Pod + tether tuning ---
// Deliberately tiny next to the ~110kg engine rig - just enough to seat
// one driver - specifically so the pod's own weight is negligible to the
// engines: the tether's mass-weighted position/velocity correction (see
// applyTether) naturally spends almost all of its correction on the much
// lighter pod and barely any on the chassis whenever their invMass ratio
// is this lopsided, which is exactly "the pod's mass shouldn't affect the
// engines" without needing any special-cased exemption.
const POD_MASS = 4;
const POD_LINEAR_DAMPING = 0.2;
// The pod's own hover repulsor uses its own (much softer) gains rather
// than the engines' HOVER_STIFFNESS/HOVER_DAMPING/MAX_HOVER_FORCE -
// those are tuned for the ~110kg chassis's mass, and would make a ~4kg
// pod's hover wildly twitchy/overpowered (same absolute force, far less
// mass to resist it). Scaled down by the same mass ratio (POD_MASS vs the
// old pod mass these were last tuned against) so the pod keeps the same
// natural frequency/damping ratio - same hover "feel" - just at its much
// lighter weight.
const POD_HOVER_STIFFNESS = 1300; // N per metre of compression
const POD_HOVER_DAMPING = 200; // N per (m/s) of vertical closing speed
const POD_MAX_HOVER_FORCE = 1600;
// Inextensible "steel cable" rope from a single anchor point on the engine
// rig (ANCHOR_LOCAL, below) to the pod: it can go slack (the pod is free
// to swing/sag/lag) but once stretched taut to TETHER_MAX_LENGTH it is a
// hard, non-stretchable limit - not a spring, so there's no "springiness"
// to the pull, just a rigid cap like a real cable going taut. Enforced
// each physics step as a position + velocity correction (see
// applyTether): push both bodies back onto the max-length sphere
// (mass-weighted, so the much lighter pod gets yanked back more than the
// heavy engine rig), then cancel the separating component of relative
// velocity with a single inelastic impulse (no bounce/elastic snap-back).
// Deliberately a *single* tether for the physics (not one per engine) - an
// isolated cannon-es smoke test (see session notes) showed 3 independent
// per-engine springs fighting each other through the shared chassis body
// produces chaotic, escalating oscillation; one rope to a central anchor
// stays stable while still visually drawing a tether line from every
// engine to the pod (see podRacer.js's tetherMeshes / syncMeshes below).
// Extra "give" added on top of the tether's taut geometric length - the
// cable only goes taut (starts constraining) once stretched past
// restLength + SLACK, so the pod has real room to swing/sag/lag before
// the cable snaps taut, instead of feeling like it's rigidly bolted on at
// a fixed distance.
const TETHER_SLACK = 0.6;
// How fast the pod's rendered facing catches up to "looking at the
// engine rig" - purely cosmetic (podBody itself has fixedRotation, so its
// physics quaternion never changes; see podFacingQuat below).
const POD_FACING_RATE = 6;

// Active self-levelling - models the repulsors as a real flight
// controller that always keeps the engine rig's PITCH level (yaw/steering
// is the only rotation the pilot actually commands), rather than a soft
// "nudge it if it's not tipped too far" anti-flip assist. Every physics
// step, regardless of grounded/airborne state:
//  1. The chassis' orientation is slerped toward a "pitch-levelled"
//     version of itself (same yaw AND roll, zero pitch) at LEVEL_RATE -
//     this is what actually guarantees it always settles back to level
//     instead of occasionally getting stuck nosed up/down. Roll is
//     deliberately left alone (see levelUpHint below) so each engine's
//     own independent hover repulsor can still bank/tilt the rig based on
//     uneven ground under one side vs the other, instead of the leveller
//     fighting/cancelling that out every step.
//  2. Any pitch angular velocity (local X) is damped out (LEVEL_ANG_DAMPING)
//     so the rig doesn't keep "wanting" to tumble between corrections and
//     fight step 1 - roll (local Z) is left to the hover repulsors, and
//     yaw (local Y) angular velocity is always zeroed outright (not just
//     damped), since yaw is purely kinematic now (see STEER_YAW_RATE in
//     applyHoverAndThrust) - any real physical yaw torque (e.g. the
//     tether's taut-cable impulse landing off-centre) must never be
//     allowed to accumulate/compound with it.
const LEVEL_RATE = 8; // how fast pitch catches up to level (1/s)
const LEVEL_ANG_DAMPING = 10; // how fast pitch spin is damped out (1/s)

const DEFAULT_BODY_COLOR = 0xff6a1a;
const RESET_LIFT_DURATION_S = 0.6;

function buildChassisBody(engineOffsets, mass) {
  const body = new CANNON.Body({ mass, material: CHASSIS_MATERIAL });
  for (const off of engineOffsets) {
    body.addShape(new CANNON.Sphere(ENGINE_RADIUS), new CANNON.Vec3(off.x, off.y, off.z));
  }
  return body;
}

/**
 * One raycast "repulsor" at a single world point: returns the upward force
 * to apply there (0 if too high to reach the ground/a roof) plus how close
 * it is to the ground, so callers can reuse the latter for the debug
 * suspension HUD / scoring's airborne check (see the virtual wheelInfos
 * built below). Stiffness/damping/max-force are parameters (not hardcoded)
 * so the much-lighter pod (see POD_HOVER_STIFFNESS etc.) can use its own
 * gains instead of the engines' - a spring tuned for the ~110kg chassis
 * would be wildly underdamped/twitchy on a pod that's deliberately only a
 * few kilos.
 */
function hoverAt(world, worldPos, verticalVelocity, rayFrom, rayTo, rayResult, stiffness, damping, maxForce) {
  rayFrom.set(worldPos.x, worldPos.y + 0.25, worldPos.z);
  rayTo.set(worldPos.x, worldPos.y - HOVER_MAX_RAY, worldPos.z);
  rayResult.reset();
  world.raycastClosest(rayFrom, rayTo, { collisionFilterMask: HOVER_RAYCAST_MASK }, rayResult);
  // No ground hit within raycast range means it's at least HOVER_MAX_RAY
  // up - treat that as the clearance (rather than bailing out with zero
  // force) so the pull-down half of the spring below still applies when
  // way up in the air (e.g. after a big jump), instead of the rig only
  // ever getting capped once it's low enough to actually see the ground
  // again.
  const clearance = rayResult.hasHit ? worldPos.y - rayResult.hitPointWorld.y : HOVER_MAX_RAY;
  const compression = HOVER_REST_HEIGHT - clearance;
  // Symmetric spring-damper: pushes up when too low (compression > 0, as
  // before) AND pulls down when too high (compression < 0) so the rig
  // can't just keep climbing forever on thrust/momentum alone - a real
  // repulsor field has a natural rest height it holds station at, not
  // just a floor it refuses to sink through.
  const force = THREE.MathUtils.clamp(compression * stiffness - verticalVelocity * damping, -maxForce, maxForce);
  return { force, clearance, grounded: clearance < HOVER_REST_HEIGHT + 0.3 };
}

/**
 * Builds the hover chassis body (+ separate tethered pod body), applies
 * thrust/steering/tether each physics step, and exposes the same shape of
 * object lib/car.js's wheeled createCar() returns
 * (vehicle/chassisBody/chassisMesh/syncMeshes/etc) so carManager.js,
 * mainLoop.js, scoring.js and the HUDs can all drive either vehicle kind
 * without knowing which one they have. Unlike the wheeled rig, this one
 * also returns `dispose()` since it owns a *second* physics body/mesh
 * group (the pod) that the generic single-body cleanup in carManager.js
 * doesn't know about.
 */
export function createChariotVehicle(world, THREE_scene, startPosition, startQuaternion, color, descriptor) {
  const engineCount = descriptor.engineCount ?? 3;
  const engineOffsets = engineLocalOffsets(engineCount);
  // Single physics anchor for the tether, at the center of the engine row
  // (every engine shares the same local Z - see podRacerLayout.js) - see
  // the TETHER_SLACK comment above for why this is one rope rather than
  // one per engine. Max length = however far apart the anchor and pod sit
  // in the original rigid layout, plus TETHER_SLACK of actual free play
  // before the cable snaps taut.
  const ANCHOR_LOCAL = new CANNON.Vec3(0, 0, ENGINE_Z);
  const tetherMaxLength =
    Math.hypot(POD_LOCAL_OFFSET.x, POD_LOCAL_OFFSET.y - 0, ENGINE_Z - POD_LOCAL_OFFSET.z) + TETHER_SLACK;

  const chassisBody = buildChassisBody(engineOffsets, 110);
  chassisBody.position.copy(startPosition);
  chassisBody.quaternion.copy(startQuaternion);
  chassisBody.linearDamping = LINEAR_DAMPING;
  chassisBody.angularDamping = ANGULAR_DAMPING;

  // Approximate rotational inertia from the craft's overall footprint
  // (same trick lib/car.js uses) so it doesn't spin like a pinwheel under
  // differential thrust.
  const halfExtents = new CANNON.Vec3(
    Math.max(...engineOffsets.map((o) => Math.abs(o.x))) + ENGINE_RADIUS,
    1.0,
    NOMINAL_CHASSIS_DEPTH
  );
  CANNON.Box.calculateInertia(halfExtents, chassisBody.mass, chassisBody.inertia);
  chassisBody.invInertia.set(
    chassisBody.inertia.x > 0 ? 1 / chassisBody.inertia.x : 0,
    chassisBody.inertia.y > 0 ? 1 / chassisBody.inertia.y : 0,
    chassisBody.inertia.z > 0 ? 1 / chassisBody.inertia.z : 0
  );
  chassisBody.updateInertiaWorld(true);
  world.addBody(chassisBody);

  // --- The pod: a separate dynamic body, tethered (not welded) to the
  // engine rig - see applyTether(). fixedRotation so its physics
  // quaternion never tumbles; the rendered pod orientation instead
  // smoothly looks toward the engine rig each frame (podFacingQuat,
  // below) which reads much better for a vehicle with no real rotational
  // inertia of its own to speak of.
  const podBody = new CANNON.Body({ mass: POD_MASS, material: CHASSIS_MATERIAL, fixedRotation: true });
  podBody.addShape(new CANNON.Sphere(POD_RADIUS));
  const podStartLocal = new CANNON.Vec3(POD_LOCAL_OFFSET.x, POD_LOCAL_OFFSET.y, POD_LOCAL_OFFSET.z);
  const podStartWorld = new CANNON.Vec3();
  startQuaternion.vmult(podStartLocal, podStartWorld);
  podStartWorld.vadd(startPosition, podStartWorld);
  podBody.position.copy(podStartWorld);
  podBody.quaternion.copy(startQuaternion);
  podBody.linearDamping = POD_LINEAR_DAMPING;
  podBody.updateMassProperties();
  world.addBody(podBody);

  // --- Control state (set by input.js via the same duck-typed API the
  // wheeled RaycastVehicle exposes, see lib/car.js/app/input.js) ---
  let throttleCommand = 0; // -1 (full reverse) .. +1 (full forward)
  let steerCommand = 0; // -1 (full right) .. +1 (full left), same sign convention as MAX_STEER
  let brakeCommand = 0;

  function applyEngineForce(value) {
    throttleCommand = THREE.MathUtils.clamp(-value / MAX_FORCE, -1, 1);
  }
  function setSteeringValue(value) {
    // Negated: the differential-thrust effect turns opposite to a naive
    // value/MAX_STEER mapping (reported as "steering works the other way
    // around" - see computeEngineThrottles below), so flip the sign here.
    steerCommand = THREE.MathUtils.clamp(-value / MAX_STEER, -1, 1);
  }
  function setBrake(value) {
    brakeCommand = value > 0 ? 1 : 0;
  }

  /**
   * Per-engine throttle for this step. All engines simply share
   * `throttleCommand` evenly - unlike earlier revisions, steering no
   * longer differentially biases engine throttle (that was a
   * force/torque-based "thrust vectoring" turn). Turning is handled
   * instead by directly rotating the chassis' velocity vector - see
   * applyKinematicSteering below - so thrust stays purely a forward/
   * backward push, same as a car's engine never steering anything by
   * itself.
   */
  function computeEngineThrottles() {
    return engineOffsets.map(() => throttleCommand);
  }

  // Scratch vectors reused every physics step (avoids per-frame GC churn,
  // matching lib/car.js's own convention for its hot-path math).
  //
  // scratchWorldPos holds an *absolute* world position (for raycasting /
  // getVelocityAtWorldPoint, both of which want that). scratchRelPos holds
  // the same point expressed as a world-oriented offset *from the body's
  // own center of mass* - cannon-es's Body.applyForce/applyImpulse both
  // require their second argument in that form (see the doc comment on
  // cannon-es's own applyForce: "relativePoint: A point relative to the
  // center of mass"), NOT an absolute world position. Passing an absolute
  // position there (easy mistake, since pointToWorldFrame conveniently
  // returns one) silently produces a bogus, position-dependent torque
  // that only misbehaves once the body is away from the world origin -
  // this is why every chassisBody.applyForce call below sources its point
  // via vectorToWorldFrame (rotation only, no translation) instead.
  const scratchWorldPos = new CANNON.Vec3();
  const scratchRelPos = new CANNON.Vec3();
  const scratchPointVel = new CANNON.Vec3();
  const scratchForce = new CANNON.Vec3();
  const scratchForward = new CANNON.Vec3();
  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const rayResult = new CANNON.RaycastResult();
  const localForward = new CANNON.Vec3(0, 0, 1);
  const steerYawQuat = new CANNON.Quaternion();

  // Tether scratch vectors.
  const tetherAnchorOffset = new CANNON.Vec3();
  const tetherAnchorWorldPos = new CANNON.Vec3();
  const tetherDir = new CANNON.Vec3();
  const tetherEngineVel = new CANNON.Vec3();
  const tetherRelVel = new CANNON.Vec3();
  const tetherImpulse = new CANNON.Vec3();

  // Virtual "wheelInfos" so scoring.js's airtime check and the debug
  // suspension HUD (both written against lib/car.js's RaycastVehicle
  // wheels) work unmodified for this vehicle too - each entry mirrors one
  // hover point's ground clearance instead of a wheel's suspension travel.
  // No cap on count - hud/suspensionHud.js now builds its bars dynamically
  // to match however many engines (+ the pod) this vehicle has.
  const hoverPoints = [...engineOffsets, POD_LOCAL_OFFSET];
  const wheelInfos = hoverPoints.map(() => ({
    radius: ENGINE_RADIUS,
    suspensionRestLength: HOVER_REST_HEIGHT,
    maxSuspensionTravel: HOVER_REST_HEIGHT,
    suspensionLength: HOVER_REST_HEIGHT,
    steering: 0,
    worldTransform: { position: new CANNON.Vec3(), quaternion: new CANNON.Quaternion() },
  }));
  // Labels for hud/suspensionHud.js's generic per-wheel bars, same order
  // as hoverPoints/wheelInfos above (every engine, then the pod last).
  const wheelLabels = engineOffsets.map((_, i) => `E${i + 1}`).concat('POD');

  /**
   * Inextensible "steel cable" rope from ANCHOR_LOCAL (on chassisBody) to
   * the pod (podBody): can go slack (no force at all while
   * dist <= tetherMaxLength) but once stretched taut it is a hard,
   * non-stretchable limit, not a spring - there's no bounce or elastic
   * "give" to the pull itself, same as a real steel cable snapping taut.
   *
   * cannon-es has no built-in one-sided max-distance constraint
   * (DistanceConstraint is rigid both ways - it would also push, which a
   * rope/cable never does), so this hand-rolls the standard two-part
   * position-based correction every physics step once taut:
   *   1. Position correction: project both bodies back onto the
   *      max-length sphere, split mass-weighted (invMass-proportional) so
   *      the much lighter pod gets pulled back more than the heavy engine
   *      rig - this is what actually prevents the cable from stretching,
   *      frame to frame, instead of merely looking taut while drifting.
   *   2. Velocity correction: cancel the separating component of the
   *      relative velocity at the anchor/pod with a single impulse
   *      (fully inelastic - no bounce), via cannon-es's own
   *      applyImpulse/getVelocityAtWorldPoint so the lever-arm/rotational
   *      coupling at the anchor is handled correctly.
   */
  function applyTether() {
    // World-oriented offset from chassisBody's center of mass to the
    // anchor (vectorToWorldFrame: rotation only, no translation) - this,
    // not the anchor's absolute world position, is what applyForce and
    // applyImpulse want as their "relativePoint" argument (see the scratch
    // vector doc comment above).
    chassisBody.vectorToWorldFrame(ANCHOR_LOCAL, tetherAnchorOffset);
    tetherAnchorWorldPos.copy(chassisBody.position).vadd(tetherAnchorOffset, tetherAnchorWorldPos);

    tetherDir.copy(podBody.position).vsub(tetherAnchorWorldPos, tetherDir);
    const dist = tetherDir.length();
    if (dist < 1e-6 || dist <= tetherMaxLength) return; // slack - cable isn't taut
    tetherDir.scale(1 / dist, tetherDir); // anchor -> pod unit vector

    const invMassChassis = chassisBody.invMass;
    const invMassPod = podBody.invMass;
    const totalInvMass = invMassChassis + invMassPod;
    if (totalInvMass <= 0) return;

    // 1. Position correction - snap both bodies back onto the max-length
    // sphere so the cable is exactly taut (not stretched) by the end of
    // this step.
    const penetration = dist - tetherMaxLength;
    const chassisFrac = invMassChassis / totalInvMass;
    const podFrac = invMassPod / totalInvMass;
    chassisBody.position.x += tetherDir.x * penetration * chassisFrac;
    chassisBody.position.y += tetherDir.y * penetration * chassisFrac;
    chassisBody.position.z += tetherDir.z * penetration * chassisFrac;
    podBody.position.x -= tetherDir.x * penetration * podFrac;
    podBody.position.y -= tetherDir.y * penetration * podFrac;
    podBody.position.z -= tetherDir.z * penetration * podFrac;

    // 2. Velocity correction - a taut cable can't keep paying out length,
    // so kill the separating component of relative velocity outright
    // (inelastic - no springy bounce-back).
    chassisBody.getVelocityAtWorldPoint(tetherAnchorWorldPos, tetherEngineVel);
    tetherRelVel.copy(podBody.velocity).vsub(tetherEngineVel, tetherRelVel);
    const sepSpeed = tetherRelVel.dot(tetherDir);
    if (sepSpeed <= 0) return; // already closing/stationary along the cable

    const impulseMag = sepSpeed / totalInvMass;
    // tetherDir points anchor -> pod; an impulse along -tetherDir on the
    // pod (and the equal/opposite reaction along +tetherDir on the
    // anchor) stops the two ends from separating further.
    tetherImpulse.copy(tetherDir).scale(-impulseMag, tetherImpulse);
    podBody.applyImpulse(tetherImpulse);
    tetherImpulse.scale(-1, tetherImpulse);
    chassisBody.applyImpulse(tetherImpulse, tetherAnchorOffset);
  }

  function applyHoverAndThrust() {
    const throttles = computeEngineThrottles();
    let anyGrounded = false;

    engineOffsets.forEach((off, i) => {
      chassisBody.pointToWorldFrame(new CANNON.Vec3(off.x, off.y, off.z), scratchWorldPos);
      chassisBody.vectorToWorldFrame(new CANNON.Vec3(off.x, off.y, off.z), scratchRelPos);
      chassisBody.getVelocityAtWorldPoint(scratchWorldPos, scratchPointVel);
      const hover = hoverAt(world, scratchWorldPos, scratchPointVel.y, rayFrom, rayTo, rayResult, HOVER_STIFFNESS, HOVER_DAMPING, MAX_HOVER_FORCE);
      if (hover.force !== 0) {
        scratchForce.set(0, hover.force, 0);
        chassisBody.applyForce(scratchForce, scratchRelPos);
      }
      anyGrounded = anyGrounded || hover.grounded;

      const thrust = brakeCommand ? 0 : throttles[i] * ENGINE_THRUST_FORCE;
      if (thrust !== 0) {
        chassisBody.vectorToWorldFrame(localForward, scratchForward);
        scratchForward.scale(thrust, scratchForce);
        chassisBody.applyForce(scratchForce, scratchRelPos);
      }

      if (i < wheelInfos.length) {
        wheelInfos[i].worldTransform.position.copy(scratchWorldPos);
        wheelInfos[i].suspensionLength = Math.min(HOVER_REST_HEIGHT * 2, Math.max(0, hover.clearance));
      }
    });
    wheelInfos[0].steering = steerCommand * MAX_STEER;

    // Car-like steering (see STEER_YAW_RATE above): bend the chassis'
    // velocity vector toward the turn - same magnitude, new direction -
    // instead of applying any force/torque for the physics to react to.
    // Keeping the facing in sync with that same rotation means next
    // step's engine thrust (always along the chassis' own local +Z) push
    // along the newly-turned direction too, instead of fighting it.
    const horizSpeedSq = chassisBody.velocity.x * chassisBody.velocity.x + chassisBody.velocity.z * chassisBody.velocity.z;
    if (Math.abs(steerCommand) > 0.02 && horizSpeedSq > MIN_STEER_SPEED * MIN_STEER_SPEED) {
      const dt = world.dt > 0 ? world.dt : 1 / 60;
      const deltaYaw = -steerCommand * STEER_YAW_RATE * dt;
      const cos = Math.cos(deltaYaw);
      const sin = Math.sin(deltaYaw);
      const vx = chassisBody.velocity.x;
      const vz = chassisBody.velocity.z;
      chassisBody.velocity.x = vx * cos + vz * sin;
      chassisBody.velocity.z = vz * cos - vx * sin;
      steerYawQuat.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), deltaYaw);
      steerYawQuat.mult(chassisBody.quaternion, chassisBody.quaternion);
      chassisBody.quaternion.normalize();
    }

    // Pod: hover only (it's dead weight dangling off the tether, not a thrust source).
    const podVerticalVel = podBody.velocity.y;
    const podHover = hoverAt(
      world,
      podBody.position,
      podVerticalVel,
      rayFrom,
      rayTo,
      rayResult,
      POD_HOVER_STIFFNESS,
      POD_HOVER_DAMPING,
      POD_MAX_HOVER_FORCE
    );
    if (podHover.force !== 0) {
      scratchForce.set(0, podHover.force, 0);
      podBody.applyForce(scratchForce);
    }
    anyGrounded = anyGrounded || podHover.grounded;
    const podSlot = wheelInfos.length - 1;
    if (podSlot >= engineOffsets.length) {
      wheelInfos[podSlot].worldTransform.position.copy(podBody.position);
      wheelInfos[podSlot].suspensionLength = Math.min(HOVER_REST_HEIGHT * 2, Math.max(0, podHover.clearance));
    }

    applyTether();

    // Gentle handbrake: bleeds off horizontal speed instead of a hard stop.
    if (brakeCommand) {
      chassisBody.velocity.x *= 0.92;
      chassisBody.velocity.z *= 0.92;
      podBody.velocity.x *= 0.92;
      podBody.velocity.z *= 0.92;
    }

    return anyGrounded;
  }

  // --- Self-levelling (see LEVEL_RATE / LEVEL_ANG_DAMPING above) ---
  const levelLocalForward = new CANNON.Vec3(0, 0, 1);
  const levelForwardWorld = new CANNON.Vec3();
  const levelFlatForward = new THREE.Vector3();
  const levelOrigin = new THREE.Vector3();
  const levelLocalUp = new CANNON.Vec3(0, 1, 0);
  const levelUpWorld = new CANNON.Vec3();
  const levelUpHint = new THREE.Vector3(0, 1, 0);
  const levelLookMatrix = new THREE.Matrix4();
  const levelTargetQuat = new THREE.Quaternion();
  const levelTargetCannon = new CANNON.Quaternion();
  const levelLocalAngVel = new CANNON.Vec3();
  // Cosmetic facing for the pod's render-only orientation (podBody itself
  // is fixedRotation - see above). Smoothly turns to look toward the
  // engine rig's current position so the pod visibly "trails" it.
  const podFacingQuat = new THREE.Quaternion().copy(startQuaternion);
  const podLookDir = new THREE.Vector3();
  const podUpHint = new THREE.Vector3(0, 1, 0);
  const podLookMatrix = new THREE.Matrix4();
  const podLookQuat = new THREE.Quaternion();
  const stabilityAssistCallback = () => {
    applyHoverAndThrust();

    // Update the pod's cosmetic facing regardless of grounded state (it
    // should keep smoothly tracking the rig even mid-air).
    podLookDir
      .set(chassisBody.position.x - podBody.position.x, chassisBody.position.y - podBody.position.y, chassisBody.position.z - podBody.position.z)
      .normalize();
    if (podLookDir.lengthSq() > 1e-8) {
      // Same lookAt-direction gotcha as the chassis leveller above: eye=D,
      // target=origin gives local +Z = D (facing TOWARD the rig). The
      // "intuitive" origin->D ordering used here previously made local +Z
      // point away from the rig instead, so the pod always rendered
      // facing backward - this is what "rotate to correct position" was
      // reporting, now self-corrects every frame without needing reset.
      podLookMatrix.lookAt(podLookDir, new THREE.Vector3(), podUpHint);
      podLookQuat.setFromRotationMatrix(podLookMatrix);
      const dt = world.dt > 0 ? world.dt : 1 / 60;
      const t = 1 - Math.exp(-POD_FACING_RATE * dt);
      podFacingQuat.slerp(podLookQuat, t);
    }

    const dt = world.dt > 0 ? world.dt : 1 / 60;

    // 1. Orientation: slerp toward "same yaw, same roll, zero pitch"
    // every step (grounded or airborne) - this is what makes the rig
    // always settle its nose back to level instead of only being nudged
    // while upright-ish and grounded. Roll is intentionally preserved
    // (levelUpHint below tracks the rig's own current up vector, rather
    // than world-up) so each engine's independently-computed hover force
    // (see applyHoverAndThrust's per-engine raycast loop) can still bank
    // the rig when the ground height differs under one side vs the other
    // - only pitch is forced flat.
    chassisBody.vectorToWorldFrame(levelLocalForward, levelForwardWorld);
    levelFlatForward.set(levelForwardWorld.x, 0, levelForwardWorld.z);
    chassisBody.vectorToWorldFrame(levelLocalUp, levelUpWorld);
    levelUpHint.set(levelUpWorld.x, levelUpWorld.y, levelUpWorld.z);
    if (levelFlatForward.lengthSq() > 1e-8) {
      levelFlatForward.normalize();
      // THREE.Matrix4.lookAt is a camera-style helper: it puts local +Z at
      // (eye - target), i.e. pointing AWAY from target. To get a matrix
      // whose local +Z (our physics "forward", see localForward above)
      // equals levelFlatForward, pass it as `eye` with the origin as
      // `target` (eye - target = levelFlatForward). Using it the "intuitive"
      // way (origin -> flatForward) flips the result 180 deg in yaw, which
      // fed back into chassisBody.quaternion every step and fought/reversed
      // steering.
      levelLookMatrix.lookAt(levelFlatForward, levelOrigin, levelUpHint);
      levelTargetQuat.setFromRotationMatrix(levelLookMatrix);
      levelTargetCannon.set(levelTargetQuat.x, levelTargetQuat.y, levelTargetQuat.z, levelTargetQuat.w);
      const levelT = 1 - Math.exp(-LEVEL_RATE * dt);
      chassisBody.quaternion.slerp(levelTargetCannon, levelT, chassisBody.quaternion);
      chassisBody.quaternion.normalize();
    }

    // 2. Angular velocity: damp out pitch spin (local X) so the rig
    // doesn't keep fighting the orientation correction above between
    // steps. Roll (local Z) is left to the independent per-engine hover
    // forces. Yaw (local Y) is always zeroed, not just while not
    // steering - yaw is now purely driven by the kinematic steering code
    // in applyHoverAndThrust, not any physical torque, so any angular
    // velocity picked up there (e.g. the tether's taut-cable impulse
    // landing off-centre and imparting a real yaw torque, which gets
    // stronger - and at high enough speed can actually overpower/reverse
    // the kinematic turn - the faster the pod lags/yanks taut) must never
    // be allowed to accumulate or compound with it.
    chassisBody.vectorToLocalFrame(chassisBody.angularVelocity, levelLocalAngVel);
    const angDampT = Math.exp(-LEVEL_ANG_DAMPING * dt);
    levelLocalAngVel.x *= angDampT;
    levelLocalAngVel.y = 0;
    chassisBody.vectorToWorldFrame(levelLocalAngVel, chassisBody.angularVelocity);
  };
  world.addEventListener('preStep', stabilityAssistCallback);
  // No separate RaycastVehicle.addToWorld() exists for this rig - the
  // preStep listener above *is* this vehicle's "preStepCallback"
  // (carManager.js removes it the same way it removes a wheeled vehicle's,
  // see car.js's wheelPreStepCallback / RaycastVehicle.addToWorld).
  const preStepCallback = stabilityAssistCallback;

  // --- Three.js meshes: separate engine-rig and pod groups (plus live
  // tether meshes stretched between them each frame), so the pod visually
  // tracks its own independent physics body instead of being nested
  // inside the engine rig's transform.
  const { engineGroup: chassisMesh, podGroup, tetherMeshes } = descriptor.buildSplitBody(THREE_scene, color);
  THREE_scene.add(chassisMesh);
  THREE_scene.add(podGroup);

  // Debug-only wireframe hitboxes: one sphere per engine (on the engine
  // rig) + one for the pod (on its own group), matching the two bodies'
  // shapes 1:1.
  const hitboxMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, depthTest: false });
  const hitboxMeshes = engineOffsets.map((off) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(ENGINE_RADIUS, 8, 6), hitboxMaterial);
    mesh.position.set(off.x, off.y, off.z);
    mesh.visible = false;
    mesh.renderOrder = 999;
    chassisMesh.add(mesh);
    return mesh;
  });
  const podHitboxMesh = new THREE.Mesh(new THREE.SphereGeometry(POD_RADIUS, 8, 6), hitboxMaterial);
  podHitboxMesh.visible = false;
  podHitboxMesh.renderOrder = 999;
  podGroup.add(podHitboxMesh);
  hitboxMeshes.push(podHitboxMesh);
  function setHitboxVisible(visible) {
    for (const m of hitboxMeshes) m.visible = visible;
  }

  // --- Fixed-step physics / variable-rate render decoupling (same
  // interpolation scheme as lib/car.js's wheeled rig), tracked separately
  // for the engine rig and the pod since they're independent bodies now.
  const prevPos = new THREE.Vector3().copy(chassisBody.position);
  const currPos = new THREE.Vector3().copy(chassisBody.position);
  const prevQuat = new THREE.Quaternion().copy(chassisBody.quaternion);
  const currQuat = new THREE.Quaternion().copy(chassisBody.quaternion);
  const prevPodPos = new THREE.Vector3().copy(podBody.position);
  const currPodPos = new THREE.Vector3().copy(podBody.position);
  const prevPodFacing = new THREE.Quaternion().copy(podFacingQuat);
  const currPodFacing = new THREE.Quaternion().copy(podFacingQuat);

  function snapshotPhysics() {
    prevPos.copy(currPos);
    prevQuat.copy(currQuat);
    currPos.copy(chassisBody.position);
    currQuat.copy(chassisBody.quaternion);

    prevPodPos.copy(currPodPos);
    prevPodFacing.copy(currPodFacing);
    currPodPos.copy(podBody.position);
    currPodFacing.copy(podFacingQuat);
  }

  function resetInterpolation() {
    currPos.copy(chassisBody.position);
    currQuat.copy(chassisBody.quaternion);
    prevPos.copy(currPos);
    prevQuat.copy(currQuat);

    currPodPos.copy(podBody.position);
    currPodFacing.copy(podFacingQuat);
    prevPodPos.copy(currPodPos);
    prevPodFacing.copy(currPodFacing);
  }

  // Reused scratch objects for stretching the tether meshes to the live,
  // interpolated engine/pod positions every render frame.
  const engineLocalVec = engineOffsets.map((off) => new THREE.Vector3(off.x, off.y, off.z));
  const engineWorldScratch = engineOffsets.map(() => new THREE.Vector3());

  function syncMeshes(alpha = 1) {
    chassisMesh.position.lerpVectors(prevPos, currPos, alpha);
    chassisMesh.quaternion.slerpQuaternions(prevQuat, currQuat, alpha);
    chassisMesh.updateMatrixWorld(true);

    podGroup.position.lerpVectors(prevPodPos, currPodPos, alpha);
    podGroup.quaternion.slerpQuaternions(prevPodFacing, currPodFacing, alpha);

    engineOffsets.forEach((off, i) => {
      engineWorldScratch[i].copy(engineLocalVec[i]);
      chassisMesh.localToWorld(engineWorldScratch[i]);
      orientStrut(tetherMeshes[i], engineWorldScratch[i], podGroup.position);
    });
  }

  let liftAnim = null;
  function uprightQuaternionPreservingHeading() {
    const euler = new CANNON.Vec3();
    chassisBody.quaternion.toEuler(euler);
    const upright = new CANNON.Quaternion();
    upright.setFromEuler(0, euler.y, 0);
    return upright;
  }

  function reset(position, quaternion) {
    const targetPosition = position ?? chassisBody.position.clone();
    if (!position) targetPosition.y += 1.5;
    const targetQuaternion = quaternion ?? uprightQuaternionPreservingHeading();
    const targetPodLocal = new CANNON.Vec3(POD_LOCAL_OFFSET.x, POD_LOCAL_OFFSET.y, POD_LOCAL_OFFSET.z);
    const targetPodWorld = new CANNON.Vec3();
    targetQuaternion.vmult(targetPodLocal, targetPodWorld);
    targetPodWorld.vadd(targetPosition, targetPodWorld);

    liftAnim = {
      startPos: chassisBody.position.clone(),
      startQuat: chassisBody.quaternion.clone(),
      targetPos: targetPosition,
      targetQuat: targetQuaternion,
      podStartPos: podBody.position.clone(),
      podTargetPos: targetPodWorld,
      elapsed: 0,
    };
    chassisBody.type = CANNON.Body.KINEMATIC;
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    podBody.type = CANNON.Body.KINEMATIC;
    podBody.velocity.set(0, 0, 0);
    podFacingQuat.copy(targetQuaternion);
    resetInterpolation();
  }

  function updateReset(dt) {
    if (!liftAnim) return;
    liftAnim.elapsed += dt;
    const t = Math.min(liftAnim.elapsed / RESET_LIFT_DURATION_S, 1);
    const eased = 1 - (1 - t) * (1 - t);
    liftAnim.startPos.lerp(liftAnim.targetPos, eased, chassisBody.position);
    liftAnim.startQuat.slerp(liftAnim.targetQuat, eased, chassisBody.quaternion);
    liftAnim.podStartPos.lerp(liftAnim.podTargetPos, eased, podBody.position);
    podBody.quaternion.copy(chassisBody.quaternion);

    if (t >= 1) {
      chassisBody.type = CANNON.Body.DYNAMIC;
      chassisBody.velocity.set(0, 0, 0);
      chassisBody.angularVelocity.set(0, 0, 0);
      podBody.type = CANNON.Body.DYNAMIC;
      podBody.velocity.set(0, 0, 0);
      liftAnim = null;
    }
  }

  // carManager.js's generic removeCurrentCar() already knows how to tear
  // down a single chassisBody/chassisMesh/preStepCallback (shared with the
  // wheeled rig) - this only needs to clean up the *extra* pieces this rig
  // alone owns: the separate pod body/mesh and its live tether meshes.
  function dispose() {
    world.removeBody(podBody);
    THREE_scene.remove(podGroup);
    for (const tether of tetherMeshes) THREE_scene.remove(tether);
  }

  // Duck-typed to match lib/car.js's RaycastVehicle-backed `vehicle`
  // object closely enough for app/input.js, app/mainLoop.js, app/scoring.js
  // and hud/suspensionHud.js to drive/read it without caring which rig
  // it actually is.
  const vehicle = {
    chassisBody,
    wheelInfos,
    wheelLabels,
    applyEngineForce,
    setSteeringValue,
    setBrake,
    preStepCallback,
  };

  return {
    vehicle,
    chassisBody,
    chassisMesh,
    wheelMeshes: [],
    syncMeshes,
    snapshotPhysics,
    reset,
    updateReset,
    setHitboxVisible,
    stabilityAssistCallback,
    dispose,
  };
}

/**
 * Visual-only copy of the local chariot (no physics) for other players -
 * same role as lib/car.js's createRemoteCar, minus the wheel spin logic
 * (hover vehicles have nothing to spin). Still uses the rigid single-group
 * body (descriptor.buildBody) since remote players only ever replicate one
 * interpolated pose for the whole vehicle, so a genuinely separate,
 * tethered pod isn't reproducible from that alone.
 */
export function createRemoteChariot(THREE_scene, color = DEFAULT_BODY_COLOR, name = '', score = 0, descriptor) {
  const { group, bodyMat } = descriptor.buildBody(0, 0, color);
  const nameTag = createNameTag(name, score);
  group.add(nameTag.sprite);
  THREE_scene.add(group);

  let currentColor = color;

  function setPose(pose) {
    group.position.set(pose.x, pose.y, pose.z);
    group.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw).normalize();
  }

  function setAppearance(nextColor, nextName, nextScore = 0) {
    if (nextColor !== currentColor) {
      currentColor = nextColor;
      bodyMat.color.set(nextColor);
    }
    nameTag.set(nextName, nextScore);
  }

  function dispose() {
    THREE_scene.remove(group);
    const materials = new Set();
    const geometries = new Set();
    group.traverse((obj) => {
      if (obj.geometry) geometries.add(obj.geometry);
      if (obj.material) {
        materials.add(obj.material);
        if (obj.material.map) obj.material.map.dispose();
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }

  return { setPose, setAppearance, dispose };
}
