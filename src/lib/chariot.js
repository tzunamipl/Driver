import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { MAX_FORCE, MAX_STEER } from '../config.js';
import { GROUND_COLLISION_GROUP } from './terrain.js';
import { BUILDING_COLLISION_GROUP } from './buildings.js';
import { CHASSIS_MATERIAL, createNameTag } from './vehicleShared.js';
import { applyAirDrag, DEFAULT_DRAG_PROFILE } from './airDrag.js';
import { ENGINE_RADIUS, POD_RADIUS, ENGINE_Z, engineLocalOffsets, POD_LOCAL_OFFSET } from './vehicles/podRacerLayout.js';
import { orientStrut, orientTetherChain } from './vehicles/podRacer.js';

// Hover/differential-thrust physics rig for "Chariots of Fire" pod-racer
// vehicles (lib/vehicles/podRacer.js) - a completely different rig from
// lib/car.js's wheeled RaycastVehicle cars, dispatched to from
// car.js's createCar/createRemoteCar whenever a vehicle descriptor has
// `vehicleType: 'hover'`. Kept in its own file per the project's "one
// file per vehicle kind, don't entangle the shared rigs" convention.
//
// Three genuinely independent bodies, no shared/invisible stand-in:
//  - `engineBodies`: one real, independent dynamic CANNON.Body per
//    engine, each with its own hover repulsor raycast and its own thrust
//    force - nothing shares a body with anything else. Every
//    engineMeshes[i] (lib/vehicles/podRacer.js's buildIndependentRig) is
//    driven 1:1 off engineBodies[i] every frame, so there is never
//    anything simulated that isn't exactly what's on screen.
//  - "Power coupling": a real spring+damper force between every pair of
//    engines (not just neighbours - see POWER_COUPLING below), pulling
//    each pair back toward their original rest separation. This, plus
//    each engine's own independent hover, is the *only* thing holding the
//    formation together - there is no rigid parent body for them to
//    track.
//  - Steering: with no single rigid body left to kinematically spin, this
//    uses real differential thrust instead - each engine's own thrust
//    magnitude is biased up/down based on which side of the formation it
//    is (see STEER_DIFF_FORCE) while every engine pushes along the same
//    shared heading vector (see computeFormationHeading). Pushing one
//    side harder than the other is a genuine net torque on the spring-
//    coupled assembly, so the formation's yaw is a real emergent result
//    of the physics, not a hand-rotated velocity vector.
//  - `podBody`: a separate dynamic body connected to the *live centroid*
//    of the three real engine bodies by a single inextensible "steel
//    cable" tether (see applyTether) - recomputed fresh from their actual
//    positions/velocities every single step (zero memory of its own), so
//    there is nothing the pod could be pulled by except the real,
//    independently-simulated, on-screen engines.
// Everything still uses simple sphere hitboxes per the "simple solids for
// graphics and hitboxes for now" brief.

const HOVER_REST_HEIGHT = 3.15;
const HOVER_MAX_RAY = HOVER_REST_HEIGHT * 3;
const HOVER_STIFFNESS = 10000; // N per metre of compression
const HOVER_DAMPING = 15; // N per (m/s) of vertical closing speed
const MAX_HOVER_FORCE = 12000;
const HOVER_RAYCAST_MASK = GROUND_COLLISION_GROUP | BUILDING_COLLISION_GROUP;

const ENGINE_THRUST_FORCE = MAX_FORCE * 200;
const LINEAR_DAMPING = 0.3;

// Real differential-thrust steering (see the file-level comment above):
// each engine's own thrust is biased by its *original* local-x sign
// (fixed at construction, not its live position, so a transient wobble
// can't flip which side an engine counts as) times steerCommand times
// this gain - a genuine extra push/pull, not a kinematic trick, so it
// needs real force to overcome the coupling springs/hover drag, same as
// any other real steering force would.
const STEER_DIFF_FORCE = MAX_FORCE * 60;
// Active yaw-rate damping (see computeFormationYawRate/applyHoverAndThrust
// below): real differential thrust has no built-in "stop turning" - once
// the formation has picked up some actual yaw rate it keeps coasting on
// its own momentum/angular inertia after the steering key is released,
// same as any other real rotating body would. This feeds the formation's
// live, measured yaw rate back in as an opposing differential-thrust
// bias every step (regardless of steerCommand, throttleCommand, or even
// ENGINE_THRUST_FORCE - this fires any time there's measured yaw rate,
// e.g. from settling/landing with zero throttle), so releasing the key
// actively brakes the turn instead of just stopping the *extra* push -
// same role LINEAR_DAMPING plays for straight-line coasting, but for yaw.
// Kept as its own independent constant (not derived from
// ENGINE_THRUST_FORCE/STEER_DIFF_FORCE) so retuning engine thrust can't
// silently change how hard idle/settling yaw gets damped out.
const YAW_DAMPING_FORCE_PER_RAD_S = MAX_FORCE * 9; // == ENGINE_THRUST_FORCE(MAX_FORCE*10) * 0.9 baseline
// Lateral "grip" - without this, differential thrust only spins the
// formation's facing while its actual momentum keeps sliding along
// whatever direction it was already moving (a frictionless-puck drift,
// reported as "it rotates but doesn't turn") - exactly what a real
// car's tires (or a boat/hovercraft's hull drag) normally prevent by
// resisting sideways motion relative to where the nose points. Modeled
// the same simple way the handbrake above bleeds off speed: every step,
// each engine's own velocity component *sideways* relative to the live
// formation heading (not the along-heading component, which is left
// alone so thrust/speed aren't touched) is bled off toward zero at this
// rate, so the formation's actual path of travel gets dragged around to
// follow its nose instead of just spinning on top of straight-line
// momentum.
const LATERAL_GRIP_RATE = 5; // 1/s - how fast sideways (relative-to-heading) velocity decays

const DEFAULT_BODY_COLOR = 0xff6a1a;
const RESET_LIFT_DURATION_S = 0.6;
const CHASSIS_MASS = 110; // total mass budget, split evenly across engines - see ENGINE_MASS below

// --- Power coupling (engine-to-engine) ---
// Real spring+damper between *every* pair of engines (not just
// neighbours), rest length = however far apart that pair's engines sit in
// the local layout - this is what keeps the independently-simulated
// engines roughly in formation. Coupling every pair (not just adjacent
// ones) braces the formation into a rigid triangle instead of a floppy
// chain, which matters since nothing else is holding these bodies
// together. Purely a center-to-center linear spring (no torque/lever-arm
// term) - each body is a simple, symmetric sphere, so there's nothing
// meaningful to apply rotational coupling to; see the cosmetic-only
// orientation handling below instead.
const POWER_COUPLING_STIFFNESS = 500; // N per metre of stretch/compression
// Progressive term on top of the linear spring above - force grows with
// the *cube* of stretch, so it's negligible at small stretch (the normal
// operating range, where a soft linear spring already holds formation and
// a stiffer one would just jitter) but ramps up hard once a pair is
// pulled noticeably apart (e.g. differential thrust during a turn), the
// same way a real repulsor field or a suspension bump-stop gets
// dramatically stiffer the further it's compressed/extended. This is what
// keeps the formation from bowing out further and further under a
// sustained turn without needing the base linear stiffness high enough to
// jitter at rest.
const POWER_COUPLING_STIFFNESS_PROGRESSIVE = 4000000; // N per (metre of stretch)^3
const POWER_COUPLING_DAMPING = 6000000; // N per (m/s) of closing/separating speed
// Raised alongside the progressive term above - the old, lower cap would
// just saturate the extra force at large stretch, defeating the point of
// making the spring stiffer out there.
const POWER_COUPLING_MAX_FORCE = 2400;

// --- Pod + tether tuning ---
// Deliberately tiny next to the ~110kg of engines (split across 3 of
// them) - specifically so the pod's own mass is negligible to the
// engines: the tether's mass-weighted position/velocity correction (see
// applyTether) naturally spends almost all of its correction on the much
// lighter pod and barely any on the engines whenever their invMass ratio
// is this lopsided, which is exactly "the pod's mass shouldn't affect the
// engines" without needing any special-cased exemption.
const POD_MASS = 4;
// Slightly stronger drag than the engines' own LINEAR_DAMPING (above) -
// the pod is dead weight dangling off the tether, not something actively
// held in formation by a spring, so it needs a bit more of its own drag
// to keep from swinging/overshooting indefinitely on its own.
const POD_LINEAR_DAMPING = LINEAR_DAMPING + 0.2;
// The pod's own hover repulsor uses its own (much softer) gains rather
// than the engines' HOVER_STIFFNESS/HOVER_DAMPING/MAX_HOVER_FORCE -
// those are tuned for one ~37kg engine's share of mass, and would make a
// ~4kg pod's hover wildly twitchy/overpowered (same absolute force, far
// less mass to resist it).
const POD_HOVER_STIFFNESS = 1300; // N per metre of compression
const POD_HOVER_DAMPING = 200; // N per (m/s) of vertical closing speed
const POD_MAX_HOVER_FORCE = 1600;
// Inextensible "steel cable" rope from the live centroid of the three
// engine bodies (see applyTether) to the pod: it can go slack (the pod is
// free to swing/sag/lag) but once stretched taut to TETHER_MAX_LENGTH it
// is a hard, non-stretchable limit - not a spring, so there's no
// "springiness" to the pull, just a rigid cap like a real cable going
// taut. Enforced each physics step as a position + velocity correction
// (see applyTether): push the pod and every engine back onto the
// max-length sphere (mass-weighted, so the much lighter pod gets yanked
// back more than the heavy engines), then cancel the separating
// component of relative velocity with a single inelastic impulse (no
// bounce/elastic snap-back). Extra "give" added on top of the tether's
// taut geometric length - the cable only goes taut (starts constraining)
// once stretched past restLength + SLACK, so the pod has real room to
// swing/sag/lag before the cable snaps taut, instead of feeling like it's
// rigidly bolted on at a fixed distance.
const TETHER_SLACK = 2.6;
// Purely cosmetic: how much the (now 3-segment, see podRacer.js's
// orientTetherChain) tether visibly bows downward once it's slack - i.e.
// once its real straight-line length (attach point -> pod) is shorter
// than the taut `tetherMaxLength` below. Scaled down from the raw slack
// distance (1 metre of cable slack shouldn't droop 1 whole metre - reads
// as way too loose/cartoonish) and capped so a fully-slack cable still
// looks like a cable, not a hoop dragging on the ground.
const TETHER_SAG_FACTOR = 0.35;
const TETHER_MAX_SAG = 1.1;

// --- Cosmetic-only engine/formation orientation ---
// The engines are simple, symmetric spheres - there is no meaningful
// rotational inertia worth actually simulating for any one of them (a
// torque-free sphere just keeps spinning forever, which reads as nothing
// at all visually). Instead, each step a "formation heading" is derived
// directly from the *real* (independently-simulated) engine positions -
// see computeFormationHeading - and every engine's rendered quaternion is
// kinematically slerped toward it; this is cosmetic-only (zero influence
// on thrust/hover/coupling physics above) but still entirely driven by
// real, live physics state, not any separate/invisible simulated body.
const ENGINE_ORIENT_RATE = 6; // 1/s - how fast each engine's rendered facing catches up to the live formation heading
const MAX_BANK_ANGLE = 0.5; // rad - clamp on how far the formation visibly banks from side-to-side engine height differences
// How fast the pod's rendered facing catches up to "looking at the
// engine formation" - purely cosmetic (podBody itself has fixedRotation,
// so its physics quaternion never changes; see podFacingQuat below).
const POD_FACING_RATE = 6;

function buildEngineBody(mass) {
  const body = new CANNON.Body({ mass, material: CHASSIS_MATERIAL });
  body.addShape(new CANNON.Sphere(ENGINE_RADIUS));
  return body;
}

/**
 * One raycast "repulsor" at a single world point: returns the upward force
 * to apply there (0 if too high to reach the ground/a roof) plus how close
 * it is to the ground, so callers can reuse the latter for the debug
 * suspension HUD / scoring's airborne check (see the virtual wheelInfos
 * built below). Stiffness/damping/max-force are parameters (not hardcoded)
 * so the much-lighter pod (see POD_HOVER_STIFFNESS etc.) can use its own
 * gains instead of the engines' - a spring tuned for one engine's share of
 * the chassis mass would be wildly underdamped/twitchy on a pod that's
 * deliberately only a few kilos.
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
 * Builds the independent engine bodies (+ separate tethered pod body),
 * applies hover/thrust/coupling/tether each physics step, and exposes the
 * same shape of object lib/car.js's wheeled createCar() returns
 * (vehicle/chassisBody/chassisMesh/syncMeshes/etc) so carManager.js,
 * mainLoop.js, scoring.js and the HUDs can all drive either vehicle kind
 * without knowing which one they have. Every system in the wider game
 * that needs exactly *one* body for a vehicle (terrain/building tunnel
 * guards, impact-roll torque, pedestrian avoidance, the HUD speed
 * readout, weapon spawn origin) is handed engineBodies[centerIndex] - the
 * real, visible centre engine, not a synthetic proxy - as `chassisBody`.
 * Unlike the wheeled rig, this one also returns `dispose()` since it owns
 * several *extra* physics bodies/meshes (the pod, plus every engine other
 * than the designated `chassisBody`) that the generic single-body cleanup
 * in carManager.js doesn't know about.
 */
export function createChariotVehicle(world, THREE_scene, startPosition, startQuaternion, color, descriptor) {
  const engineCount = descriptor.engineCount ?? 3;
  // See lib/airDrag.js - applied relative to the shared, live formation
  // heading (headingForward/computeFormationHeading), since no single
  // engine body's own quaternion is an authoritative "facing" for the rig.
  const dragProfile = descriptor.dragProfile ?? DEFAULT_DRAG_PROFILE;
  const engineOffsets = engineLocalOffsets(engineCount);
  const centerIndex = Math.min(Math.floor(engineCount / 2), engineCount - 1);
  // Engine indices sorted by local x (left to right) - fixed at
  // construction from the layout, not re-derived from live positions each
  // step, so a transient wobble can't flip which engine counts as
  // "leftmost"/"rightmost" for heading/bank/steering purposes below.
  const sortedIndices = engineOffsets.map((_, i) => i).sort((a, b) => engineOffsets[a].x - engineOffsets[b].x);
  const leftmostIndex = sortedIndices[0];
  const rightmostIndex = sortedIndices[sortedIndices.length - 1];

  const tetherMaxLength =
    Math.hypot(POD_LOCAL_OFFSET.x, POD_LOCAL_OFFSET.y - 0, ENGINE_Z - POD_LOCAL_OFFSET.z) + TETHER_SLACK;

  // --- The engines: one real, independent dynamic body each. No shared
  // rigid group, no invisible formation reference - every engineBodies[i]
  // below is exactly what engineMeshes[i] (see descriptor.buildIndependentRig)
  // renders, 1:1, every frame.
  const engineMass = CHASSIS_MASS / engineCount;
  const engineBodies = engineOffsets.map((off) => {
    const body = buildEngineBody(engineMass);
    const worldOff = new CANNON.Vec3();
    startQuaternion.vmult(new CANNON.Vec3(off.x, off.y, off.z), worldOff);
    body.position.copy(startPosition).vadd(worldOff, body.position);
    body.quaternion.copy(startQuaternion);
    body.linearDamping = LINEAR_DAMPING;
    world.addBody(body);
    return body;
  });
  // Designated single-body reference for every cross-cutting system
  // (terrain/building guards, scoring, pedestrians, HUD, weapon origin -
  // see carManager.js/collisions.js/scoring.js) that needs exactly one
  // body for "the vehicle" - the real, visible centre engine, never a
  // synthetic stand-in.
  const chassisBody = engineBodies[centerIndex];

  // Power-coupling rest length for every unique pair of engines, taken
  // from their local layout offsets (not their live positions) - this is
  // the separation the springs below try to hold each pair at.
  const couplingPairs = [];
  for (let i = 0; i < engineCount; i++) {
    for (let j = i + 1; j < engineCount; j++) {
      const a = engineOffsets[i];
      const b = engineOffsets[j];
      couplingPairs.push({ i, j, restLength: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) });
    }
  }

  // --- The pod: a separate dynamic body, tethered (not welded) to the
  // live centroid of the engines - see applyTether(). fixedRotation so
  // its physics quaternion never tumbles; the rendered pod orientation
  // instead smoothly looks toward the engine formation each frame
  // (podFacingQuat, below) which reads much better for a vehicle with no
  // real rotational inertia of its own to speak of.
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
    // Negated: the differential-thrust effect below turns opposite to a
    // naive value/MAX_STEER mapping, same sign convention this rig has
    // always used for its (previously kinematic, now real-force)
    // steering - see STEER_DIFF_FORCE.
    steerCommand = THREE.MathUtils.clamp(-value / MAX_STEER, -1, 1);
  }
  function setBrake(value) {
    brakeCommand = value > 0 ? 1 : 0;
  }

  // Scratch vectors reused every physics step (avoids per-frame GC churn,
  // matching lib/car.js's own convention for its hot-path math).
  const scratchForce = new CANNON.Vec3();
  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const rayResult = new CANNON.RaycastResult();
  const couplingDelta = new CANNON.Vec3();
  const couplingRelVel = new CANNON.Vec3();

  // Formation-heading scratch (see computeFormationHeading).
  const headingRight = new THREE.Vector3();
  const headingForward = new THREE.Vector3();
  const headingUp = new THREE.Vector3();
  let lastGoodForward = new THREE.Vector3(0, 0, 1).applyQuaternion(
    new THREE.Quaternion(startQuaternion.x, startQuaternion.y, startQuaternion.z, startQuaternion.w)
  );
  const formationLookMatrix = new THREE.Matrix4();
  const formationQuat = new THREE.Quaternion();
  let lastHorizDist = 0;

  // Tether scratch vectors.
  const tetherCentroid = new CANNON.Vec3();
  const tetherCentroidVel = new CANNON.Vec3();
  const tetherDir = new CANNON.Vec3();
  const tetherRelVel = new CANNON.Vec3();
  const tetherImpulse = new CANNON.Vec3();

  // Virtual "wheelInfos" so scoring.js's airtime check and the debug
  // suspension HUD (both written against lib/car.js's RaycastVehicle
  // wheels) work unmodified for this vehicle too - each entry mirrors one
  // hover point's ground clearance instead of a wheel's suspension travel.
  const hoverCount = engineCount + 1; // every engine, then the pod last
  const wheelInfos = Array.from({ length: hoverCount }, () => ({
    radius: ENGINE_RADIUS,
    suspensionRestLength: HOVER_REST_HEIGHT,
    maxSuspensionTravel: HOVER_REST_HEIGHT,
    suspensionLength: HOVER_REST_HEIGHT,
    steering: 0,
    worldTransform: { position: new CANNON.Vec3(), quaternion: new CANNON.Quaternion() },
  }));
  const wheelLabels = engineOffsets.map((_, i) => `E${i + 1}`).concat('POD');

  /**
   * Derives the formation's real, live heading/bank entirely from the
   * independently-simulated engines' actual current positions - no
   * kinematic/accumulated state of its own, so it can never drift out of
   * sync with what's physically happening:
   *  - "right" = the real vector from the leftmost to the rightmost
   *    engine (horizontal component only) - if the formation has
   *    genuinely yawed (the coupling springs + differential thrust above
   *    actually rotate the real engine positions), this vector rotates
   *    right along with it.
   *  - "forward" = that right vector rotated -90 degrees about world up,
   *    matching this rig's existing +Z-is-forward convention.
   *  - bank (roll) = the real height difference between the leftmost and
   *    rightmost engine, clamped - lets the rendered formation visibly
   *    tilt when independent per-engine hover genuinely holds one side
   *    higher than the other, same as a real banking aircraft/hovercraft.
   * Falls back to the last good heading if the two outer engines are
   * ever coincident (degenerate engineCount=1 case) so this never divides
   * by zero.
   */
  function computeFormationHeading() {
    const left = engineBodies[leftmostIndex].position;
    const right = engineBodies[rightmostIndex].position;
    headingRight.set(right.x - left.x, 0, right.z - left.z);
    const horizDist = headingRight.length();
    if (horizDist < 1e-4) {
      headingForward.copy(lastGoodForward);
    } else {
      headingRight.multiplyScalar(1 / horizDist);
      // forward = right x up, matching local +Z = (0,0,1) when right = (1,0,0), up = (0,1,0).
      headingForward.set(-headingRight.z, 0, headingRight.x).normalize();
      lastGoodForward.copy(headingForward);
    }

    const bank = THREE.MathUtils.clamp(Math.atan2(right.y - left.y, Math.max(horizDist, 1e-4)), -MAX_BANK_ANGLE, MAX_BANK_ANGLE);
    headingUp.set(0, 1, 0).applyAxisAngle(headingForward, bank);

    formationLookMatrix.lookAt(headingForward, new THREE.Vector3(), headingUp);
    formationQuat.setFromRotationMatrix(formationLookMatrix);
    lastHorizDist = horizDist;
    return formationQuat;
  }

  /**
   * The formation's real, live yaw rate (rad/s) - how fast headingForward
   * (above) is actually rotating right now, derived the same way: the
   * leftmost/rightmost engines' *relative* velocity has a component along
   * the current forward axis exactly when the "right" vector between them
   * is rotating (picture two points on a spinning rod - the one ahead in
   * the rotation is moving forward relative to the other), so dividing
   * that component by their separation gives the formation's angular
   * velocity directly from real, independently-simulated physics state -
   * nothing kinematic/remembered. Used to actively damp residual spin
   * once steering input stops (see YAW_DAMPING_FORCE_PER_RAD_S) - must be
   * called right after computeFormationHeading (reuses its headingForward
   * and horizDist).
   */
  function computeFormationYawRate() {
    if (lastHorizDist < 1e-4) return 0;
    const left = engineBodies[leftmostIndex].velocity;
    const right = engineBodies[rightmostIndex].velocity;
    const relVelX = right.x - left.x;
    const relVelZ = right.z - left.z;
    const perp = relVelX * headingForward.x + relVelZ * headingForward.z;
    return perp / lastHorizDist;
  }

  /**
   * Real spring+damper between every pair of engines (see couplingPairs
   * above), pulling each pair back toward their original rest separation.
   * Center-to-center only (zero relativePoint) - these are simple,
   * symmetric spheres, so there's no meaningful lever arm to apply a
   * torque through, and nothing here needs one (see the cosmetic-only
   * orientation handling instead).
   */
  function applyPowerCoupling() {
    for (const pair of couplingPairs) {
      const a = engineBodies[pair.i];
      const b = engineBodies[pair.j];
      couplingDelta.copy(b.position).vsub(a.position, couplingDelta);
      const dist = couplingDelta.length();
      if (dist < 1e-6) continue;
      couplingDelta.scale(1 / dist, couplingDelta); // a -> b unit vector

      couplingRelVel.copy(b.velocity).vsub(a.velocity, couplingRelVel);
      const closingSpeed = couplingRelVel.dot(couplingDelta);
      const stretch = dist - pair.restLength;
      // Linear term for soft, jitter-free behaviour near rest length, plus
      // a cubic term (sign-preserving: stretch^3, not Math.abs(stretch)^3)
      // that only bites once a pair is pulled noticeably apart - see
      // POWER_COUPLING_STIFFNESS_PROGRESSIVE above.
      const forceMag = THREE.MathUtils.clamp(
        stretch * POWER_COUPLING_STIFFNESS +
          stretch * stretch * stretch * POWER_COUPLING_STIFFNESS_PROGRESSIVE +
          closingSpeed * POWER_COUPLING_DAMPING,
        -POWER_COUPLING_MAX_FORCE,
        POWER_COUPLING_MAX_FORCE
      );
      // Positive forceMag (stretched/separating) pulls b toward a and a
      // toward b.
      scratchForce.copy(couplingDelta).scale(forceMag, scratchForce);
      b.applyForce(scratchForce.scale(-1, scratchForce));
      a.applyForce(scratchForce.scale(-1, scratchForce));
    }
  }

  /**
   * Inextensible "steel cable" rope from the live centroid of the engines
   * to the pod (podBody): can go slack (no force at all while
   * dist <= tetherMaxLength) but once stretched taut it is a hard,
   * non-stretchable limit, not a spring - there's no bounce or elastic
   * "give" to the pull itself, same as a real steel cable snapping taut.
   * The centroid is recomputed from the real engines' positions/
   * velocities every single call - it has zero state of its own, so
   * there is nothing here the pod could be pulled by except the actual,
   * independently-simulated, on-screen engines.
   *
   * cannon-es has no built-in one-sided max-distance constraint
   * (DistanceConstraint is rigid both ways - it would also push, which a
   * rope/cable never does), so this hand-rolls the standard two-part
   * position-based correction every physics step once taut:
   *   1. Position correction: project both the pod and every engine back
   *      toward the max-length sphere, split mass-weighted (invMass-
   *      proportional, engines sharing their portion evenly) so the much
   *      lighter pod gets pulled back more than the heavy engines.
   *   2. Velocity correction: cancel the separating component of the
   *      relative velocity with a single impulse (fully inelastic - no
   *      bounce), split the same way across the engines.
   */
  function applyTether() {
    tetherCentroid.set(0, 0, 0);
    tetherCentroidVel.set(0, 0, 0);
    for (const body of engineBodies) {
      tetherCentroid.vadd(body.position, tetherCentroid);
      tetherCentroidVel.vadd(body.velocity, tetherCentroidVel);
    }
    tetherCentroid.scale(1 / engineCount, tetherCentroid);
    tetherCentroidVel.scale(1 / engineCount, tetherCentroidVel);

    tetherDir.copy(podBody.position).vsub(tetherCentroid, tetherDir);
    const dist = tetherDir.length();
    if (dist < 1e-6 || dist <= tetherMaxLength) return; // slack - cable isn't taut
    tetherDir.scale(1 / dist, tetherDir); // centroid -> pod unit vector

    const invMassPerEngine = engineBodies[0].invMass;
    const totalEnginesInvMass = invMassPerEngine * engineCount;
    const invMassPod = podBody.invMass;
    const totalInvMass = totalEnginesInvMass + invMassPod;
    if (totalInvMass <= 0) return;

    // 1. Position correction - snap the pod and every engine back onto
    // the max-length sphere so the cable is exactly taut (not stretched)
    // by the end of this step.
    const penetration = dist - tetherMaxLength;
    const podFrac = invMassPod / totalInvMass;
    const enginesFrac = totalEnginesInvMass / totalInvMass;
    podBody.position.x -= tetherDir.x * penetration * podFrac;
    podBody.position.y -= tetherDir.y * penetration * podFrac;
    podBody.position.z -= tetherDir.z * penetration * podFrac;
    const perEngineFrac = enginesFrac / engineCount;
    for (const body of engineBodies) {
      body.position.x += tetherDir.x * penetration * perEngineFrac;
      body.position.y += tetherDir.y * penetration * perEngineFrac;
      body.position.z += tetherDir.z * penetration * perEngineFrac;
    }

    // 2. Velocity correction - a taut cable can't keep paying out length,
    // so kill the separating component of relative velocity outright
    // (inelastic - no springy bounce-back).
    tetherRelVel.copy(podBody.velocity).vsub(tetherCentroidVel, tetherRelVel);
    const sepSpeed = tetherRelVel.dot(tetherDir);
    if (sepSpeed <= 0) return; // already closing/stationary along the cable

    const impulseMag = sepSpeed / totalInvMass;
    // tetherDir points centroid -> pod; an impulse along -tetherDir on
    // the pod (and the equal/opposite reaction split across the engines
    // along +tetherDir) stops the two ends from separating further.
    tetherImpulse.copy(tetherDir).scale(-impulseMag, tetherImpulse);
    podBody.applyImpulse(tetherImpulse);
    const perEngineImpulseMag = impulseMag / engineCount;
    tetherImpulse.copy(tetherDir).scale(perEngineImpulseMag, tetherImpulse);
    for (const body of engineBodies) body.applyImpulse(tetherImpulse);
  }

  function applyHoverAndThrust() {
    let anyGrounded = false;
    const heading = computeFormationHeading();
    const sharedForward = headingForward; // already real/live, see computeFormationHeading
    const sharedRight = headingRight; // already real/live, see computeFormationHeading
    // Measured right now, before any of this step's forces are applied -
    // see computeFormationYawRate/YAW_DAMPING_FORCE_PER_RAD_S.
    const yawRate = computeFormationYawRate();
    const stepDt = world.dt > 0 ? world.dt : 1 / 60;

    engineBodies.forEach((body, i) => {
      const hover = hoverAt(world, body.position, body.velocity.y, rayFrom, rayTo, rayResult, HOVER_STIFFNESS, HOVER_DAMPING, MAX_HOVER_FORCE);
      if (hover.force !== 0) {
        scratchForce.set(0, hover.force, 0);
        body.applyForce(scratchForce);
      }
      anyGrounded = anyGrounded || hover.grounded;

      // Differential thrust: every engine pushes along the same real,
      // shared heading (sharedForward) - only the *magnitude* differs per
      // engine (throttle shared by all, plus a steering bias that's
      // positive on one side and negative on the other, by that engine's
      // fixed original side). The resulting net torque on the spring-
      // coupled assembly is what actually yaws the formation - see the
      // file-level comment. A yaw-rate damping bias is layered in
      // unconditionally (even with no steering input, even under brake)
      // so any already-picked-up spin actively bleeds off instead of
      // coasting on its own momentum once the key is released.
      const sideSign = Math.sign(engineOffsets[i].x);
      const steerBias = brakeCommand ? 0 : steerCommand * sideSign * STEER_DIFF_FORCE;
      const yawDampingBias = -yawRate * sideSign * YAW_DAMPING_FORCE_PER_RAD_S;
      const thrustForce = brakeCommand ? 0 : throttleCommand * ENGINE_THRUST_FORCE / engineCount;
      const totalThrust = thrustForce + steerBias + yawDampingBias;
      if (totalThrust !== 0) {
        scratchForce.set(sharedForward.x * totalThrust, sharedForward.y * totalThrust, sharedForward.z * totalThrust);
        body.applyForce(scratchForce);
      }

      // Lateral grip (see LATERAL_GRIP_RATE above): bleed off this
      // engine's own velocity component sideways relative to the live
      // heading (sharedRight), leaving the along-heading component
      // untouched - this is what actually redirects the formation's path
      // of travel to follow its nose as it yaws, instead of the nose
      // spinning on top of unchanged straight-line momentum.
      const lateralSpeed = body.velocity.x * sharedRight.x + body.velocity.z * sharedRight.z;
      if (lateralSpeed !== 0) {
        const gripT = 1 - Math.exp(-LATERAL_GRIP_RATE * stepDt);
        body.velocity.x -= sharedRight.x * lateralSpeed * gripT;
        body.velocity.z -= sharedRight.z * lateralSpeed * gripT;
      }

      // Universal directional air drag (see lib/airDrag.js) - every engine
      // is its own independent body, so each gets its own drag force, all
      // relative to the one shared live heading rather than this body's
      // own (cosmetic-only) quaternion.
      applyAirDrag(body, sharedForward, dragProfile);

      wheelInfos[i].worldTransform.position.copy(body.position);
      wheelInfos[i].suspensionLength = Math.min(HOVER_REST_HEIGHT * 2, Math.max(0, hover.clearance));

      // Cosmetic-only facing: slerp this engine's rendered quaternion
      // toward the live formation heading - see ENGINE_ORIENT_RATE. Zero
      // influence on the physics above (thrust direction already comes
      // straight from sharedForward, not from body.quaternion).
      const t = 1 - Math.exp(-ENGINE_ORIENT_RATE * stepDt);
      const bq = body.quaternion;
      const bodyQuatThree = reusableQuatA.set(bq.x, bq.y, bq.z, bq.w);
      bodyQuatThree.slerp(heading, t);
      bq.set(bodyQuatThree.x, bodyQuatThree.y, bodyQuatThree.z, bodyQuatThree.w);
      body.angularVelocity.set(0, 0, 0);
    });
    wheelInfos[0].steering = steerCommand * MAX_STEER;

    applyPowerCoupling();

    // Pod: hover only (it's dead weight dangling off the tether, not a thrust source).
    const podHover = hoverAt(
      world,
      podBody.position,
      podBody.velocity.y,
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
    // The pod (dead weight on the tether) gets the same drag treatment,
    // using the shared heading too - podBody.quaternion is fixedRotation
    // and never updates, so it's not a usable "facing" reference.
    applyAirDrag(podBody, sharedForward, dragProfile);
    const podSlot = wheelInfos.length - 1;
    wheelInfos[podSlot].worldTransform.position.copy(podBody.position);
    wheelInfos[podSlot].suspensionLength = Math.min(HOVER_REST_HEIGHT * 2, Math.max(0, podHover.clearance));

    applyTether();

    // Gentle handbrake: bleeds off horizontal speed instead of a hard stop.
    if (brakeCommand) {
      for (const body of engineBodies) {
        body.velocity.x *= 0.92;
        body.velocity.z *= 0.92;
      }
      podBody.velocity.x *= 0.92;
      podBody.velocity.z *= 0.92;
    }

    return anyGrounded;
  }

  // Scratch reused by the per-engine cosmetic slerp above (avoids
  // allocating a THREE.Quaternion every engine, every step).
  const reusableQuatA = new THREE.Quaternion();

  // Cosmetic facing for the pod's render-only orientation (podBody itself
  // is fixedRotation - see above). Smoothly turns to look toward the
  // engine formation's live centroid so the pod visibly "trails" it.
  const podFacingQuat = new THREE.Quaternion().copy(startQuaternion);
  const podLookDir = new THREE.Vector3();
  const podUpHint = new THREE.Vector3(0, 1, 0);
  const podLookMatrix = new THREE.Matrix4();
  const podLookQuat = new THREE.Quaternion();
  const stabilityAssistCallback = () => {
    applyHoverAndThrust();

    // Update the pod's cosmetic facing regardless of grounded state (it
    // should keep smoothly tracking the formation even mid-air).
    tetherCentroid.set(0, 0, 0);
    for (const body of engineBodies) tetherCentroid.vadd(body.position, tetherCentroid);
    tetherCentroid.scale(1 / engineCount, tetherCentroid);
    podLookDir
      .set(tetherCentroid.x - podBody.position.x, tetherCentroid.y - podBody.position.y, tetherCentroid.z - podBody.position.z)
      .normalize();
    if (podLookDir.lengthSq() > 1e-8) {
      // lookAt(eye=D, target=origin) gives local +Z = D (facing TOWARD
      // the formation) - see the matching note on the engine heading
      // above, same convention.
      podLookMatrix.lookAt(podLookDir, new THREE.Vector3(), podUpHint);
      podLookQuat.setFromRotationMatrix(podLookMatrix);
      const dt = world.dt > 0 ? world.dt : 1 / 60;
      const t = 1 - Math.exp(-POD_FACING_RATE * dt);
      podFacingQuat.slerp(podLookQuat, t);
    }
  };
  world.addEventListener('preStep', stabilityAssistCallback);
  // No separate RaycastVehicle.addToWorld() exists for this rig - the
  // preStep listener above *is* this vehicle's "preStepCallback"
  // (carManager.js removes it the same way it removes a wheeled vehicle's,
  // see car.js's wheelPreStepCallback / RaycastVehicle.addToWorld).
  const preStepCallback = stabilityAssistCallback;

  // --- Three.js meshes: one real group per engine (engineMeshes[i]
  // synced 1:1 to engineBodies[i] every frame), live power-coupling
  // struts, a separate pod group, and live tether meshes - there is no
  // invisible proxy anywhere, every mesh below is driven directly off a
  // real physics body.
  const {
    engineMeshes,
    couplingMeshes,
    couplingPairs: visualCouplingPairs,
    podGroup,
    tetherMeshes,
    tetherAttachLocal,
  } = descriptor.buildIndependentRig(THREE_scene, color);
  // carManager.js's generic cleanup does `scene.remove(chassisMesh)` for
  // whichever single mesh is returned top-level - that must be the same
  // real engine mesh as chassisBody (engineMeshes[centerIndex]), so
  // removing "the chassis" removes a real, visible engine, not a
  // leftover/placeholder.
  const chassisMesh = engineMeshes[centerIndex];

  // Debug-only wireframe hitboxes: one sphere per engine (attached
  // directly to that engine's own mesh) + one for the pod.
  const hitboxMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, depthTest: false });
  const hitboxMeshes = engineMeshes.map((mesh) => {
    const hitbox = new THREE.Mesh(new THREE.SphereGeometry(ENGINE_RADIUS, 8, 6), hitboxMaterial);
    hitbox.visible = false;
    hitbox.renderOrder = 999;
    mesh.add(hitbox);
    return hitbox;
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
  // per engine and for the pod.
  const prevPos = engineBodies.map((body) => new THREE.Vector3().copy(body.position));
  const currPos = engineBodies.map((body) => new THREE.Vector3().copy(body.position));
  const prevQuat = engineBodies.map((body) => new THREE.Quaternion().copy(body.quaternion));
  const currQuat = engineBodies.map((body) => new THREE.Quaternion().copy(body.quaternion));
  const prevPodPos = new THREE.Vector3().copy(podBody.position);
  const currPodPos = new THREE.Vector3().copy(podBody.position);
  const prevPodFacing = new THREE.Quaternion().copy(podFacingQuat);
  const currPodFacing = new THREE.Quaternion().copy(podFacingQuat);
  // Reused scratch for stretching each tether/coupling strut between its
  // two (interpolated) real engine/pod positions every frame.
  const tetherAttachScratch = new THREE.Vector3();

  function snapshotPhysics() {
    engineBodies.forEach((body, i) => {
      prevPos[i].copy(currPos[i]);
      prevQuat[i].copy(currQuat[i]);
      currPos[i].copy(body.position);
      currQuat[i].copy(body.quaternion);
    });

    prevPodPos.copy(currPodPos);
    prevPodFacing.copy(currPodFacing);
    currPodPos.copy(podBody.position);
    currPodFacing.copy(podFacingQuat);
  }

  function resetInterpolation() {
    engineBodies.forEach((body, i) => {
      currPos[i].copy(body.position);
      currQuat[i].copy(body.quaternion);
      prevPos[i].copy(currPos[i]);
      prevQuat[i].copy(currQuat[i]);
    });

    currPodPos.copy(podBody.position);
    currPodFacing.copy(podFacingQuat);
    prevPodPos.copy(currPodPos);
    prevPodFacing.copy(currPodFacing);
  }

  function syncMeshes(alpha = 1) {
    engineMeshes.forEach((mesh, i) => {
      mesh.position.lerpVectors(prevPos[i], currPos[i], alpha);
      mesh.quaternion.slerpQuaternions(prevQuat[i], currQuat[i], alpha);
      mesh.updateMatrixWorld(true);
    });

    podGroup.position.lerpVectors(prevPodPos, currPodPos, alpha);
    podGroup.quaternion.slerpQuaternions(prevPodFacing, currPodFacing, alpha);

    // Every power-coupling strut and tether runs between its two real,
    // live (interpolated) engine/pod meshes - not an approximation of
    // them - so a strut/tether visibly stretches exactly as far as its
    // two real endpoints actually are from each other this frame.
    visualCouplingPairs.forEach(([i, j], k) => {
      orientStrut(couplingMeshes[k], engineMeshes[i].position, engineMeshes[j].position);
    });
    tetherMeshes.forEach((tether, i) => {
      tetherAttachScratch.copy(tetherAttachLocal[i]).applyQuaternion(engineMeshes[i].quaternion).add(engineMeshes[i].position);
      // Slack (see TETHER_SLACK/applyTether) = how much shorter the real,
      // live attach-point-to-pod distance is than the taut cap - sag the
      // chain's interior joints down by that much (scaled/capped, see
      // TETHER_SAG_FACTOR/TETHER_MAX_SAG) so a genuinely slack cable
      // visibly hangs instead of always reading as one rigid straight rod.
      const dist = tetherAttachScratch.distanceTo(podGroup.position);
      const slack = Math.max(0, tetherMaxLength - dist);
      const sag = Math.min(slack * TETHER_SAG_FACTOR, TETHER_MAX_SAG);
      orientTetherChain(tether, tetherAttachScratch, podGroup.position, sag);
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

    const engineLiftAnims = engineBodies.map((body, i) => {
      const off = engineOffsets[i];
      const targetLocal = new CANNON.Vec3(off.x, off.y, off.z);
      const targetWorld = new CANNON.Vec3();
      targetQuaternion.vmult(targetLocal, targetWorld);
      targetWorld.vadd(targetPosition, targetWorld);
      return { startPos: body.position.clone(), targetPos: targetWorld };
    });

    liftAnim = {
      startQuat: chassisBody.quaternion.clone(),
      targetQuat: targetQuaternion,
      engineLiftAnims,
      podStartPos: podBody.position.clone(),
      podTargetPos: targetPodWorld,
      elapsed: 0,
    };
    for (const body of engineBodies) {
      body.type = CANNON.Body.KINEMATIC;
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
    }
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

    const liftQuat = new CANNON.Quaternion();
    liftAnim.startQuat.slerp(liftAnim.targetQuat, eased, liftQuat);
    engineBodies.forEach((body, i) => {
      const anim = liftAnim.engineLiftAnims[i];
      anim.startPos.lerp(anim.targetPos, eased, body.position);
      body.quaternion.copy(liftQuat);
    });
    liftAnim.podStartPos.lerp(liftAnim.podTargetPos, eased, podBody.position);

    if (t >= 1) {
      for (const body of engineBodies) {
        body.type = CANNON.Body.DYNAMIC;
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
      }
      podBody.type = CANNON.Body.DYNAMIC;
      podBody.velocity.set(0, 0, 0);
      liftAnim = null;
    }
  }

  // carManager.js's generic removeCurrentCar() already knows how to tear
  // down a single chassisBody/chassisMesh/preStepCallback pair (shared
  // with the wheeled rig) - that pair is engineBodies[centerIndex]/
  // engineMeshes[centerIndex] here, so this only needs to clean up the
  // *extra* pieces this rig alone owns: the pod body/mesh, the live
  // tether/coupling meshes, and every engine other than the designated
  // chassisBody.
  function dispose() {
    engineBodies.forEach((body, i) => {
      if (body === chassisBody) return;
      world.removeBody(body);
    });
    engineMeshes.forEach((mesh, i) => {
      if (mesh === chassisMesh) return;
      THREE_scene.remove(mesh);
    });
    for (const strut of couplingMeshes) THREE_scene.remove(strut);
    world.removeBody(podBody);
    THREE_scene.remove(podGroup);
    for (const tether of tetherMeshes) tether.forEach((segment) => THREE_scene.remove(segment));
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
    // Every real engine body, not just the designated `chassisBody` (see
    // app/collisions.js's ground/building tunnel+embed guards) - without
    // this, those guards only ever caught/corrected the centre engine,
    // leaving the two outer ones free to tunnel straight through terrain
    // or buildings while still strongly power-coupled to the corrected
    // centre engine (and, via couplingPairs, directly to *each other*),
    // which read as "the edge engines clip through obstacles together,
    // independently of the middle one".
    tunnelGuardBodies: engineBodies,
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
 * interpolated pose for the whole vehicle, so genuinely independent
 * per-engine physics isn't reproducible from that alone.
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
