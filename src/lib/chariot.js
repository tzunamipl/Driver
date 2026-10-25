// Hover rig for Chariot of Fire hover vehicles (descriptor.vehicleType ===
// 'hover', dispatched from car.js). No rigid chassis:
//  - each engine is an independent dynamic sphere with its own hover
//    repulsor and thrust (engineMeshes[i] renders engineBodies[i] 1:1);
//  - engines are held in formation only by power-coupling springs;
//  - steering is differential thrust along the shared live heading, so yaw
//    emerges from the physics;
//  - the pod is a separate body on a one-sided tether to the engine centroid.
// Returns the same rig API as car.js's createCar so the rest of the game
// doesn't care which kind it drives.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { MAX_STEER } from '../config.js';
import {
  CHASSIS_MATERIAL,
  createHitboxMaterial,
  hitboxMesh,
  liftedResetPosition,
  resetLiftProgress,
  shiftPoints,
  uprightQuaternion,
} from './vehicleShared.js';
import { applyAirDrag, DEFAULT_DRAG_PROFILE } from './airDrag.js';
import { ENGINE_RADIUS, POD_RADIUS, ENGINE_Z, engineLocalOffsets, POD_LOCAL_OFFSET } from './vehicles/chariotOfFireLayout.js';
import { orientStrut, orientTetherChain } from './vehicles/chariotOfFire.js';
import { HOVER_REST_HEIGHT, hoverAt } from './chariot/hover.js';
import { createFormationHeading, createPowerCoupling, createTether, engineCentroid } from './chariot/formation.js';
import { createRemoteChariot as createRemote } from './chariot/remote.js';

const DEFAULT_BODY_COLOR = 0xff6a1a;
const DEFAULT_CHASSIS_MASS = 110; // kg, split evenly across engines
const DEFAULT_ENGINE_THRUST_FORCE = 2000; // N per engine at full throttle

const ENGINE_HOVER = {
  stiffness: 50000, // N/m
  damping: 2500, // N/(m/s)
  maxForce: 1200000,
  minEngage: HOVER_REST_HEIGHT, // equal min/max = no dead zone
  maxEngage: 100,
};
// Much softer than the engines' - the pod is far lighter.
const POD_HOVER = { stiffness: 6300, damping: 200, maxForce: 5600, minEngage: 1.2, maxEngage: 400 };

// Gains as fractions of one engine's thrust, so they scale with power.
const STEER_DIFF_FORCE_RATIO = 0.9;
const YAW_DAMPING_FORCE_RATIO = 0.135;
const LINEAR_DAMPING = 0.3;
// 1/s decay of each engine's sideways velocity relative to the heading;
// without it the formation spins but keeps sliding straight.
const LATERAL_GRIP_RATE = 5;
const HANDBRAKE_VELOCITY_FACTOR = 0.92; // per step, horizontal

const POD_MASS = 250;
const POD_LINEAR_DAMPING = LINEAR_DAMPING + 0.2; // dangling dead weight needs more drag
const POD_LIFT_COEFFICIENT = 0.4; // N per (m/s)^2 of forward speed
const TETHER_SLACK = 7.1; // m of give beyond the taut layout length
// Cosmetic droop of a slack tether: slack * factor, capped.
const TETHER_SAG_FACTOR = 0.2;
const TETHER_MAX_SAG = 2.3;

// Cosmetic orientation rates (1/s): engines slerp toward the formation
// heading, the pod toward facing the engines. No effect on physics.
const ENGINE_ORIENT_RATE = 6;
const POD_FACING_RATE = 6;
const RESET_LIFT_HEIGHT = 1.5;

/** Local offset rotated by `quat` and added to `origin`. */
function placeLocal(offset, quat, origin) {
  const out = new CANNON.Vec3();
  quat.vmult(new CANNON.Vec3(offset.x, offset.y, offset.z), out);
  out.vadd(origin, out); // returns undefined when given a target
  return out;
}

/**
 * `chassisBody`/`chassisMesh` are the real centre engine, used by every
 * system needing one body (tunnel guards, scoring, HUD, weapons). dispose()
 * removes the extra bodies/meshes carManager's generic cleanup doesn't know.
 */
export function createChariotVehicle(world, scene, startPosition, startQuaternion, color, descriptor) {
  const engineCount = descriptor.engineCount ?? 3;
  const engineThrustForce = descriptor.engineThrustForce ?? DEFAULT_ENGINE_THRUST_FORCE;
  const steerDiffForce = engineThrustForce * STEER_DIFF_FORCE_RATIO;
  const yawDampingForcePerRadS = engineThrustForce * YAW_DAMPING_FORCE_RATIO;
  const dragProfile = descriptor.dragProfile ?? DEFAULT_DRAG_PROFILE;
  const engineOffsets = engineLocalOffsets(engineCount);
  const centerIndex = Math.min(Math.floor(engineCount / 2), engineCount - 1);
  const tetherMaxLength =
    Math.hypot(POD_LOCAL_OFFSET.x, POD_LOCAL_OFFSET.y, ENGINE_Z - POD_LOCAL_OFFSET.z) + TETHER_SLACK;

  const engineMass = (descriptor.mass ?? DEFAULT_CHASSIS_MASS) / engineCount;
  const engineBodies = engineOffsets.map((off) => {
    const body = new CANNON.Body({ mass: engineMass, material: CHASSIS_MATERIAL });
    body.addShape(new CANNON.Sphere(ENGINE_RADIUS));
    body.position.copy(placeLocal(off, startQuaternion, startPosition));
    body.quaternion.copy(startQuaternion);
    body.linearDamping = LINEAR_DAMPING;
    world.addBody(body);
    return body;
  });
  const chassisBody = engineBodies[centerIndex];

  // fixedRotation: the rendered pod orientation is cosmetic (podFacingQuat).
  const podBody = new CANNON.Body({ mass: POD_MASS, material: CHASSIS_MATERIAL, fixedRotation: true });
  podBody.addShape(new CANNON.Sphere(POD_RADIUS));
  podBody.position.copy(placeLocal(POD_LOCAL_OFFSET, startQuaternion, startPosition));
  podBody.quaternion.copy(startQuaternion);
  podBody.linearDamping = POD_LINEAR_DAMPING;
  podBody.updateMassProperties();
  world.addBody(podBody);

  const heading = createFormationHeading(engineBodies, engineOffsets, startQuaternion);
  const applyPowerCoupling = createPowerCoupling(engineBodies, engineOffsets);
  const applyTether = createTether(engineBodies, podBody, tetherMaxLength);

  // --- Controls (same duck-typed API as wheeledVehicle.js, driven by input.js) ---
  let throttleCommand = 0; // -1..1
  let steerCommand = 0; // -1 (right)..1 (left)
  let brakeCommand = 0;
  // input.js leaves engineForce unset here, so `value` is a plain ±throttle.
  const applyEngineForce = (value) => (throttleCommand = THREE.MathUtils.clamp(-value, -1, 1));
  // Negated: differential thrust turns opposite to the naive mapping.
  const setSteeringValue = (value) => (steerCommand = THREE.MathUtils.clamp(-value / MAX_STEER, -1, 1));
  const setBrake = (value) => (brakeCommand = value > 0 ? 1 : 0);

  const scratchForce = new CANNON.Vec3();
  const ray = { rayFrom: new CANNON.Vec3(), rayTo: new CANNON.Vec3(), rayResult: new CANNON.RaycastResult() };
  const quatScratch = new THREE.Quaternion();

  // Virtual wheelInfos (each engine, then the pod) so scoring's landed
  // check and suspensionHud work unchanged; length = hover clearance.
  const wheelInfos = Array.from({ length: engineCount + 1 }, () => ({
    radius: ENGINE_RADIUS,
    suspensionRestLength: HOVER_REST_HEIGHT,
    maxSuspensionTravel: HOVER_REST_HEIGHT,
    suspensionLength: HOVER_REST_HEIGHT,
    steering: 0,
    worldTransform: { position: new CANNON.Vec3(), quaternion: new CANNON.Quaternion() },
  }));
  const wheelLabels = engineOffsets.map((_, i) => `E${i + 1}`).concat('POD');
  const setHoverInfo = (slot, body, clearance) => {
    wheelInfos[slot].worldTransform.position.copy(body.position);
    wheelInfos[slot].suspensionLength = Math.min(HOVER_REST_HEIGHT * 2, Math.max(0, clearance));
  };

  function applyHoverAndThrust() {
    let anyGrounded = false;
    const headingQuat = heading.update();
    const { forward, right } = heading;
    const yawRate = heading.yawRate(); // measured before this step's forces
    const stepDt = world.dt > 0 ? world.dt : 1 / 60;

    engineBodies.forEach((body, i) => {
      const hover = hoverAt(world, body.position, body.velocity.y, ray, ENGINE_HOVER);
      if (hover.force !== 0) body.applyForce(scratchForce.set(0, hover.force, 0));
      anyGrounded = anyGrounded || hover.grounded;

      // All engines push along the shared heading; magnitude differs by
      // side (steering) plus a yaw-rate damping term that bleeds residual spin.
      const sideSign = Math.sign(engineOffsets[i].x);
      const steerBias = brakeCommand ? 0 : steerCommand * sideSign * steerDiffForce;
      const yawDampingBias = -yawRate * sideSign * yawDampingForcePerRadS;
      const thrustForce = brakeCommand ? 0 : throttleCommand * engineThrustForce;
      const totalThrust = thrustForce + steerBias + yawDampingBias;
      if (totalThrust !== 0) {
        body.applyForce(scratchForce.set(forward.x * totalThrust, forward.y * totalThrust, forward.z * totalThrust));
      }

      const lateralSpeed = body.velocity.x * right.x + body.velocity.z * right.z;
      if (lateralSpeed !== 0) {
        const gripT = 1 - Math.exp(-LATERAL_GRIP_RATE * stepDt);
        body.velocity.x -= right.x * lateralSpeed * gripT;
        body.velocity.z -= right.z * lateralSpeed * gripT;
      }

      applyAirDrag(body, forward, dragProfile);
      setHoverInfo(i, body, hover.clearance);

      // Cosmetic facing only - thrust direction comes from `forward`.
      const bq = body.quaternion;
      quatScratch.set(bq.x, bq.y, bq.z, bq.w).slerp(headingQuat, 1 - Math.exp(-ENGINE_ORIENT_RATE * stepDt));
      bq.set(quatScratch.x, quatScratch.y, quatScratch.z, quatScratch.w);
      body.angularVelocity.set(0, 0, 0);
    });
    wheelInfos[0].steering = steerCommand * MAX_STEER;

    applyPowerCoupling();

    // Pod: hover + speed-squared lift + drag, no thrust.
    const podHover = hoverAt(world, podBody.position, podBody.velocity.y, ray, POD_HOVER);
    if (podHover.force !== 0) podBody.applyForce(scratchForce.set(0, podHover.force, 0));
    anyGrounded = anyGrounded || podHover.grounded;
    const podForwardSpeed = podBody.velocity.x * forward.x + podBody.velocity.z * forward.z;
    const podLiftForce = POD_LIFT_COEFFICIENT * podForwardSpeed * podForwardSpeed;
    if (podLiftForce !== 0) podBody.applyForce(scratchForce.set(0, podLiftForce, 0));
    applyAirDrag(podBody, forward, dragProfile);
    setHoverInfo(wheelInfos.length - 1, podBody, podHover.clearance);

    applyTether();

    if (brakeCommand) {
      for (const body of [...engineBodies, podBody]) {
        body.velocity.x *= HANDBRAKE_VELOCITY_FACTOR;
        body.velocity.z *= HANDBRAKE_VELOCITY_FACTOR;
      }
    }
    return anyGrounded;
  }

  // Cosmetic pod facing: smoothly looks toward the engine centroid.
  const podFacingQuat = new THREE.Quaternion().copy(startQuaternion);
  const centroidScratch = new CANNON.Vec3();
  const podLookDir = new THREE.Vector3();
  const podUpHint = new THREE.Vector3(0, 1, 0);
  const podLookMatrix = new THREE.Matrix4();
  const podLookQuat = new THREE.Quaternion();

  // This preStep listener is the rig's whole per-step update.
  const stabilityAssistCallback = () => {
    applyHoverAndThrust();
    engineCentroid(engineBodies, centroidScratch);
    const p = podBody.position;
    podLookDir.set(centroidScratch.x - p.x, centroidScratch.y - p.y, centroidScratch.z - p.z).normalize();
    if (podLookDir.lengthSq() > 1e-8) {
      podLookMatrix.lookAt(podLookDir, new THREE.Vector3(), podUpHint);
      podLookQuat.setFromRotationMatrix(podLookMatrix);
      const dt = world.dt > 0 ? world.dt : 1 / 60;
      podFacingQuat.slerp(podLookQuat, 1 - Math.exp(-POD_FACING_RATE * dt));
    }
  };
  world.addEventListener('preStep', stabilityAssistCallback);

  // --- Meshes ---
  const {
    engineMeshes,
    couplingMeshes,
    couplingPairs: visualCouplingPairs,
    podGroup,
    tetherMeshes,
    tetherAttachLocal,
  } = descriptor.buildIndependentRig(scene, color);
  const chassisMesh = engineMeshes[centerIndex];

  const hitboxMaterial = createHitboxMaterial();
  const hitboxMeshes = engineMeshes.map((mesh) => {
    const hitbox = hitboxMesh(new THREE.SphereGeometry(ENGINE_RADIUS, 8, 6), hitboxMaterial);
    mesh.add(hitbox);
    return hitbox;
  });
  const podHitbox = hitboxMesh(new THREE.SphereGeometry(POD_RADIUS, 8, 6), hitboxMaterial);
  podGroup.add(podHitbox);
  hitboxMeshes.push(podHitbox);
  function setHitboxVisible(visible) {
    for (const m of hitboxMeshes) m.visible = visible;
  }

  // --- Render interpolation (see car.js), per engine and for the pod ---
  const prevPos = engineBodies.map((body) => new THREE.Vector3().copy(body.position));
  const currPos = engineBodies.map((body) => new THREE.Vector3().copy(body.position));
  const prevQuat = engineBodies.map((body) => new THREE.Quaternion().copy(body.quaternion));
  const currQuat = engineBodies.map((body) => new THREE.Quaternion().copy(body.quaternion));
  const prevPodPos = new THREE.Vector3().copy(podBody.position);
  const currPodPos = new THREE.Vector3().copy(podBody.position);
  const prevPodFacing = new THREE.Quaternion().copy(podFacingQuat);
  const currPodFacing = new THREE.Quaternion().copy(podFacingQuat);
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

    // Struts and tethers stretch between the interpolated meshes.
    visualCouplingPairs.forEach(([i, j], k) => {
      orientStrut(couplingMeshes[k], engineMeshes[i].position, engineMeshes[j].position);
    });
    tetherMeshes.forEach((tether, i) => {
      tetherAttachScratch.copy(tetherAttachLocal[i]).applyQuaternion(engineMeshes[i].quaternion).add(engineMeshes[i].position);
      const slack = Math.max(0, tetherMaxLength - tetherAttachScratch.distanceTo(podGroup.position));
      orientTetherChain(tether, tetherAttachScratch, podGroup.position, Math.min(slack * TETHER_SAG_FACTOR, TETHER_MAX_SAG));
    });
  }

  // --- Reset (see car.js): every body eases kinematically into the layout ---
  let liftAnim = null;
  const allBodies = [...engineBodies, podBody];

  function reset(position, quaternion) {
    const targetPos = position ?? liftedResetPosition(world, chassisBody, RESET_LIFT_HEIGHT);
    const targetQuat = quaternion ?? uprightQuaternion(chassisBody);
    liftAnim = {
      startQuat: chassisBody.quaternion.clone(),
      targetQuat,
      engines: engineBodies.map((body, i) => ({
        startPos: body.position.clone(),
        targetPos: placeLocal(engineOffsets[i], targetQuat, targetPos),
      })),
      podStartPos: podBody.position.clone(),
      podTargetPos: placeLocal(POD_LOCAL_OFFSET, targetQuat, targetPos),
      elapsed: 0,
    };
    for (const body of allBodies) {
      body.type = CANNON.Body.KINEMATIC;
      body.velocity.set(0, 0, 0);
    }
    for (const body of engineBodies) body.angularVelocity.set(0, 0, 0);
    podFacingQuat.copy(targetQuat);
    resetInterpolation();
  }

  function updateReset(dt) {
    if (!liftAnim) return;
    liftAnim.elapsed += dt;
    const { t, eased } = resetLiftProgress(liftAnim.elapsed);
    const liftQuat = new CANNON.Quaternion();
    liftAnim.startQuat.slerp(liftAnim.targetQuat, eased, liftQuat);
    engineBodies.forEach((body, i) => {
      const anim = liftAnim.engines[i];
      anim.startPos.lerp(anim.targetPos, eased, body.position);
      body.quaternion.copy(liftQuat);
    });
    liftAnim.podStartPos.lerp(liftAnim.podTargetPos, eased, podBody.position);

    if (t >= 1) {
      for (const body of allBodies) {
        body.type = CANNON.Body.DYNAMIC;
        body.velocity.set(0, 0, 0);
      }
      for (const body of engineBodies) body.angularVelocity.set(0, 0, 0);
      liftAnim = null;
    }
  }

  /** Floating-origin shift of interpolation and reset state (bodies/meshes move generically). */
  function shiftOrigin(dx, dz) {
    shiftPoints([...prevPos, ...currPos, prevPodPos, currPodPos], dx, dz);
    if (liftAnim) {
      for (const anim of liftAnim.engines) shiftPoints([anim.startPos, anim.targetPos], dx, dz);
      shiftPoints([liftAnim.podStartPos, liftAnim.podTargetPos], dx, dz);
    }
  }

  function dispose() {
    for (const body of engineBodies) if (body !== chassisBody) world.removeBody(body);
    for (const mesh of engineMeshes) if (mesh !== chassisMesh) scene.remove(mesh);
    for (const strut of couplingMeshes) scene.remove(strut);
    world.removeBody(podBody);
    scene.remove(podGroup);
    for (const tether of tetherMeshes) tether.forEach((segment) => scene.remove(segment));
  }

  const vehicle = {
    chassisBody,
    wheelInfos,
    wheelLabels,
    applyEngineForce,
    setSteeringValue,
    setBrake,
    preStepCallback: stabilityAssistCallback,
    // All engines, so collisions.js's tunnel guards catch the outer ones too.
    tunnelGuardBodies: engineBodies,
    vehicleType: descriptor.vehicleType,
    scoresAirtime: descriptor.scoresAirtime ?? true,
  };

  return {
    vehicle,
    chassisBody,
    chassisMesh,
    podMesh: podGroup, // for cameraViews/pod.js's mountPoint: 'pod'
    wheelMeshes: [],
    syncMeshes,
    snapshotPhysics,
    reset,
    updateReset,
    isResetting: () => liftAnim !== null,
    setHitboxVisible,
    stabilityAssistCallback,
    dispose,
    shiftOrigin,
  };
}

/** Visual-only Chariot of Fire for another player. */
export function createRemoteChariot(scene, color = DEFAULT_BODY_COLOR, name = '', score = 0, descriptor) {
  return createRemote(scene, color, name, score, descriptor);
}
