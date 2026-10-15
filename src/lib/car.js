// Vehicle factory. createCar/createRemoteCar build the selected vehicle
// (vehicles/index.js); hover vehicles are delegated to chariot.js, the rest
// share this wheeled rig and differ only by descriptor tuning + body mesh.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { getVehicle, DEFAULT_VEHICLE_ID } from './vehicles/index.js';
import {
  CHASSIS_MATERIAL,
  createNameTag,
  liftedResetPosition,
  resetLiftProgress,
  shiftPoints,
  uprightQuaternion,
} from './vehicleShared.js';
import { createChariotVehicle, createRemoteChariot } from './chariot.js';
import { applyAirDrag, DEFAULT_DRAG_PROFILE } from './airDrag.js';
import { createWheeledVehicle } from './wheeledVehicle.js';
import { createEngineState } from './engine.js';
import { MAX_STEER } from '../config.js';
import { GRAVITY } from './physicsConstants.js';
import {
  CHASSIS_WIDTH,
  CHASSIS_HEIGHT,
  CHASSIS_LENGTH,
  AXLE_HALF_WIDTH,
  WHEEL_FRONT_Z,
  WHEEL_BACK_Z,
  fitChassisHitbox,
  createChassisBody,
  applyFootprintInertia,
  buildChassisHitboxMeshes,
} from './car/chassis.js';
import { wheelRadiusOf, buildWheelMesh } from './car/wheelMesh.js';
import { createRemoteWheeledCar } from './car/remote.js';

export { CHASSIS_MATERIAL, createNameTag };

const DEFAULT_BODY_COLOR = 0xffffff;
// Descriptor fallbacks (each vehicle normally sets its own).
const DEFAULT_CHASSIS_MASS = 1500; // kg
const DEFAULT_BRAKE_FORCE = 100;
const DEFAULT_DRIVE_WHEELS = [2, 3]; // RWD
const DEFAULT_ABS = true;
const DEFAULT_STEER_SPEED_D = 0.1;
// Suspension force cap as a multiple of static per-wheel load. Caps grip on
// hard landings so the car slides instead of snapping straight in one step.
const DEFAULT_SUSPENSION_FORCE_G = 8;
const WHEELS_PER_VEHICLE = 4;
// Legacy flat engine force (N/hp); only used by rigs without engine.js.
const FORCE_PER_HP = 0;
const ANGULAR_DAMPING = 0.6; // bleeds residual spin so bumps don't build into tumbles
const WHEEL_HITBOX_PED_GROUP = 16; // pedestrians' collision group (pedestrians.js)

const DEFAULT_WHEEL_OPTIONS = {
  directionLocal: new CANNON.Vec3(0, -1, 0),
  suspensionStiffness: 35, // ~7cm static sag
  suspensionRestLength: 0.55,
  axleLocal: new CANNON.Vec3(-1, 0, 0),
  maxSuspensionTravel: 0.35, // must clear static sag with headroom, or the car leans stuck
};
const DEFAULT_TYRE_WIDTH_MM = 225;
const DEFAULT_TYRE_PROFILE = 45;

/**
 * Creates the local, physics-driven vehicle. Returns the rig API used by
 * carManager/mainLoop/input/HUDs: { vehicle, chassisBody, chassisMesh,
 * wheelMeshes, syncMeshes, snapshotPhysics, reset, updateReset,
 * setHitboxVisible, stabilityAssistCallback, dispose }.
 */
export function createCar(
  world,
  scene,
  startPosition = new CANNON.Vec3(0, 1, 0),
  startQuaternion = new CANNON.Quaternion(0, 0, 0, 1),
  color = DEFAULT_BODY_COLOR,
  vehicleId = DEFAULT_VEHICLE_ID
) {
  const descriptor = getVehicle(vehicleId);
  if (descriptor.vehicleType === 'hover') {
    return createChariotVehicle(world, scene, startPosition, startQuaternion, color, descriptor);
  }

  const chassisMass = descriptor.mass ?? DEFAULT_CHASSIS_MASS;
  const { group: chassisMesh } = descriptor.buildBody(CHASSIS_WIDTH, CHASSIS_LENGTH, color);
  const hitbox = fitChassisHitbox(chassisMesh);
  const chassisBody = createChassisBody(chassisMass, startPosition, startQuaternion, hitbox);

  // Custom raycast vehicle (wheeledVehicle.js) instead of CANNON.RaycastVehicle.
  const vehicle = createWheeledVehicle({ chassisBody, indexRightAxis: 0, indexUpAxis: 1, indexForwardAxis: 2 });

  const wheelRadius = wheelRadiusOf(descriptor);
  const suspensionForceG = descriptor.suspensionForceG ?? DEFAULT_SUSPENSION_FORCE_G;
  const tyreWidth = (descriptor.tyre ?? DEFAULT_TYRE_WIDTH_MM) / 1000;
  const wheelOptions = {
    ...DEFAULT_WHEEL_OPTIONS,
    radius: wheelRadius,
    width: tyreWidth,
    sidewallHeight: (tyreWidth * (descriptor.profile ?? DEFAULT_TYRE_PROFILE)) / 100,
    maxSuspensionForce: ((chassisMass * GRAVITY) / WHEELS_PER_VEHICLE) * suspensionForceG,
    ...descriptor.suspension,
  };

  // Attached at the chassis underside for pitch/roll stability. Chassis-local
  // +X renders on the screen's left, so order is FL, FR, RL, RR to match
  // wheelLabels and suspensionHud's grid.
  const attachY = -CHASSIS_HEIGHT / 2;
  const wheelPositions = [
    new CANNON.Vec3(AXLE_HALF_WIDTH, attachY, WHEEL_FRONT_Z),
    new CANNON.Vec3(-AXLE_HALF_WIDTH, attachY, WHEEL_FRONT_Z),
    new CANNON.Vec3(AXLE_HALF_WIDTH, attachY, WHEEL_BACK_Z),
    new CANNON.Vec3(-AXLE_HALF_WIDTH, attachY, WHEEL_BACK_Z),
  ];
  for (const pos of wheelPositions) vehicle.addWheel({ ...wheelOptions, chassisConnectionPointLocal: pos });
  vehicle.addToWorld(world);

  vehicle.vehicleType = descriptor.vehicleType;
  vehicle.wheelLabels = ['FL', 'FR', 'RL', 'RR'];
  vehicle.engineForce = descriptor.enginePowerHp * FORCE_PER_HP;
  vehicle.engine = createEngineState(descriptor, wheelRadius); // rpm/gearbox, driven by input.js
  vehicle.driveWheels = descriptor.driveWheels ?? DEFAULT_DRIVE_WHEELS; // indices into wheelInfos
  vehicle.brakeForce = descriptor.brakeForce ?? DEFAULT_BRAKE_FORCE;
  vehicle.abs = descriptor.abs ?? DEFAULT_ABS; // pedal brake backs off before locking
  // Speed-sensitive steering lock; input.js lerps between these by speed.
  vehicle.steerSpeedD = descriptor.steerSpeedD ?? DEFAULT_STEER_SPEED_D;
  vehicle.maxSteerAt0 = descriptor.maxSteerAt0 ?? MAX_STEER;
  vehicle.maxSteerAt100 = descriptor.maxSteerAt100 ?? MAX_STEER;

  // Signed speed along the chassis forward axis (negative = reversing);
  // input.js uses it to decide brake vs reverse.
  const forwardLocal = new CANNON.Vec3(0, 0, 1);
  const forwardWorld = new CANNON.Vec3();
  vehicle.getForwardSpeed = () => {
    chassisBody.vectorToWorldFrame(forwardLocal, forwardWorld);
    return chassisBody.velocity.dot(forwardWorld);
  };
  // Mean tread speed of the driven wheels (m/s, + = forward); the engine's
  // rpm follows this, so it revs on wheelspin and in the air.
  vehicle.getDriveWheelSpeed = () => {
    let sum = 0;
    for (const i of vehicle.driveWheels) sum += vehicle.wheelInfos[i].spinSpeed;
    return -sum / vehicle.driveWheels.length;
  };

  // Wheels stick out past the chassis shapes, so each gets a kinematic
  // sphere that only collides with pedestrians, synced every physics step.
  const wheelHitboxBodies = wheelPositions.map(() => {
    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.KINEMATIC,
      collisionFilterGroup: 1,
      collisionFilterMask: WHEEL_HITBOX_PED_GROUP,
    });
    body.addShape(new CANNON.Sphere(wheelRadius));
    world.addBody(body);
    return body;
  });
  const syncWheelHitboxes = () => {
    for (let i = 0; i < wheelHitboxBodies.length; i++) {
      vehicle.updateWheelTransform(i);
      const t = vehicle.wheelInfos[i].worldTransform;
      wheelHitboxBodies[i].position.copy(t.position);
      wheelHitboxBodies[i].quaternion.copy(t.quaternion);
    }
  };
  world.addEventListener('preStep', syncWheelHitboxes);
  vehicle.wheelHitboxBodies = wheelHitboxBodies;
  vehicle.ignoreBodies.push(...wheelHitboxBodies); // else suspension rays hit them

  const groundDrop = -attachY + wheelOptions.suspensionRestLength + wheelOptions.radius;
  applyFootprintInertia(chassisBody, new CANNON.Vec3(AXLE_HALF_WIDTH, groundDrop, WHEEL_FRONT_Z - WHEEL_BACK_Z));
  chassisBody.angularDamping = ANGULAR_DAMPING;

  const dragProfile = descriptor.dragProfile ?? DEFAULT_DRAG_PROFILE;
  const stabilityAssistCallback = () => {
    chassisBody.vectorToWorldFrame(forwardLocal, forwardWorld);
    applyAirDrag(chassisBody, forwardWorld, dragProfile);
  };
  world.addEventListener('preStep', stabilityAssistCallback);

  // --- Meshes ---
  scene.add(chassisMesh);
  const hitboxMeshes = buildChassisHitboxMeshes(chassisMesh, hitbox);
  function setHitboxVisible(visible) {
    for (const m of hitboxMeshes) m.visible = visible;
  }
  const wheelMeshes = wheelPositions.map(() => buildWheelMesh(descriptor, scene));

  // --- Render interpolation ---
  // Physics runs at a fixed step; render lerps between the last two steps
  // so a varying substep count per frame doesn't show as jitter.
  const prevChassisPos = new THREE.Vector3().copy(chassisBody.position);
  const currChassisPos = new THREE.Vector3().copy(chassisBody.position);
  const prevChassisQuat = new THREE.Quaternion().copy(chassisBody.quaternion);
  const currChassisQuat = new THREE.Quaternion().copy(chassisBody.quaternion);
  const prevWheelPos = wheelPositions.map(() => new THREE.Vector3());
  const currWheelPos = wheelPositions.map(() => new THREE.Vector3());
  const prevWheelQuat = wheelPositions.map(() => new THREE.Quaternion());
  const currWheelQuat = wheelPositions.map(() => new THREE.Quaternion());

  function readWheelTransforms(posArr, quatArr) {
    vehicle.wheelInfos.forEach((wheel, i) => {
      vehicle.updateWheelTransform(i);
      posArr[i].copy(wheel.worldTransform.position);
      quatArr[i].copy(wheel.worldTransform.quaternion);
    });
  }
  readWheelTransforms(prevWheelPos, prevWheelQuat);
  readWheelTransforms(currWheelPos, currWheelQuat);

  /** Call after every fixed world.step(). */
  function snapshotPhysics() {
    prevChassisPos.copy(currChassisPos);
    prevChassisQuat.copy(currChassisQuat);
    currChassisPos.copy(chassisBody.position);
    currChassisQuat.copy(chassisBody.quaternion);
    for (let i = 0; i < wheelPositions.length; i++) {
      prevWheelPos[i].copy(currWheelPos[i]);
      prevWheelQuat[i].copy(currWheelQuat[i]);
    }
    readWheelTransforms(currWheelPos, currWheelQuat);
  }

  /** Sets prev = curr = now, so a teleport doesn't interpolate. */
  function resetInterpolation() {
    currChassisPos.copy(chassisBody.position);
    currChassisQuat.copy(chassisBody.quaternion);
    prevChassisPos.copy(currChassisPos);
    prevChassisQuat.copy(currChassisQuat);
    readWheelTransforms(currWheelPos, currWheelQuat);
    for (let i = 0; i < wheelPositions.length; i++) {
      prevWheelPos[i].copy(currWheelPos[i]);
      prevWheelQuat[i].copy(currWheelQuat[i]);
    }
  }

  /** @param {number} alpha - 0..1 between previous and current physics step. */
  function syncMeshes(alpha = 1) {
    chassisMesh.position.lerpVectors(prevChassisPos, currChassisPos, alpha);
    chassisMesh.quaternion.slerpQuaternions(prevChassisQuat, currChassisQuat, alpha);
    wheelMeshes.forEach((mesh, i) => {
      mesh.position.lerpVectors(prevWheelPos[i], currWheelPos[i], alpha);
      mesh.quaternion.slerpQuaternions(prevWheelQuat[i], currWheelQuat[i], alpha);
    });
  }

  // --- Reset ---
  // Without arguments: rights the car in place (same heading, lifted).
  // The body is kinematic while updateReset() eases it into the pose.
  let liftAnim = null;

  function reset(position, quaternion) {
    const targetPos = position ?? liftedResetPosition(world, chassisBody, CHASSIS_HEIGHT + 0.5);
    liftAnim = {
      startPos: chassisBody.position.clone(),
      startQuat: chassisBody.quaternion.clone(),
      targetPos,
      targetQuat: quaternion ?? uprightQuaternion(chassisBody),
      elapsed: 0,
    };
    chassisBody.type = CANNON.Body.KINEMATIC;
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    vehicle.resetWheelSpin();
    resetInterpolation();
  }

  /** Call every render frame (wall-clock duration). */
  function updateReset(dt) {
    if (!liftAnim) return;
    liftAnim.elapsed += dt;
    const { t, eased } = resetLiftProgress(liftAnim.elapsed);
    liftAnim.startPos.lerp(liftAnim.targetPos, eased, chassisBody.position);
    liftAnim.startQuat.slerp(liftAnim.targetQuat, eased, chassisBody.quaternion);
    if (t >= 1) {
      chassisBody.type = CANNON.Body.DYNAMIC;
      chassisBody.velocity.set(0, 0, 0);
      chassisBody.angularVelocity.set(0, 0, 0);
      vehicle.resetWheelSpin();
      liftAnim = null;
    }
  }

  /** Floating-origin shift of the state carManager's generic body/scene shift can't see. */
  function shiftOrigin(dx, dz) {
    shiftPoints([prevChassisPos, currChassisPos, ...prevWheelPos, ...currWheelPos], dx, dz);
    if (liftAnim) shiftPoints([liftAnim.startPos, liftAnim.targetPos], dx, dz);
  }

  /** Removes the extras carManager's generic cleanup doesn't know about. */
  function dispose() {
    world.removeEventListener('preStep', syncWheelHitboxes);
    for (const body of wheelHitboxBodies) world.removeBody(body);
  }

  return {
    vehicle,
    chassisBody,
    chassisMesh,
    wheelMeshes,
    syncMeshes,
    snapshotPhysics,
    reset,
    updateReset,
    setHitboxVisible,
    stabilityAssistCallback,
    dispose,
    shiftOrigin,
  };
}

/** Visual-only vehicle for another player: { setPose, setAppearance, dispose }. */
export function createRemoteCar(scene, color = DEFAULT_BODY_COLOR, name = '', score = 0, vehicleId = DEFAULT_VEHICLE_ID) {
  const descriptor = getVehicle(vehicleId);
  if (descriptor.vehicleType === 'hover') {
    return createRemoteChariot(scene, color, name, score, descriptor);
  }
  return createRemoteWheeledCar(scene, color, name, score, descriptor);
}
