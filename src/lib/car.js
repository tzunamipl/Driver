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
import { applyWaterDrag } from './waterDrag.js';
import { createWheeledVehicle } from './wheeledVehicle.js';
import { createEngineState } from './engine.js';
import { createFuelTank } from './fuel.js';
import { MAX_STEER } from '../config.js';
import { GRAVITY } from './physicsConstants.js';
import {
  CHASSIS_WIDTH,
  CHASSIS_HEIGHT,
  CHASSIS_LENGTH,
  fitChassisHitbox,
  createChassisBody,
  applyFootprintInertia,
  buildChassisHitboxMeshes,
} from './car/chassis.js';
import { wheelRadiusOf, buildWheelSet, setWheelSetFlat } from './car/wheelMesh.js';
import { resolveAxles, layoutWheels, createSteeringGeometry, wheelSetWidth } from './car/axles.js';
import { createTrailerHitch, placeTrailer } from './car/trailer.js';
import { createRemoteWheeledCar } from './car/remote.js';

export { CHASSIS_MATERIAL, createNameTag };

const DEFAULT_BODY_COLOR = 0xffffff;
// Descriptor fallbacks (each vehicle normally sets its own).
const DEFAULT_CHASSIS_MASS = 1500; // kg
const DEFAULT_TRAILER_MASS = 5000; // kg
const DEFAULT_BRAKE_FORCE = 100;
const DEFAULT_ABS = true;
// Front axles' share of the pedal brake: the rear unloads under braking, so an
// even split locks it first and swaps the car's ends.
const DEFAULT_BRAKE_BIAS = 0.70;
const DEFAULT_STEER_SPEED_D = 0.1;
// Rear (unsteered) tyres keep this share of their dynamic grip once sliding,
// so a broken-loose rear holds the slide while the fronts still catch it.
const DEFAULT_REAR_SLIDE_GRIP = 0.99;
// Suspension force cap as a multiple of static per-wheel load. Caps grip on
// hard landings so the car slides instead of snapping straight in one step.
const DEFAULT_SUSPENSION_FORCE_G = 8;
// Descriptor spring/damper rates are for this many wheels; more wheels share them.
const REFERENCE_WHEEL_COUNT = 4;
// Legacy flat engine force (N/hp); only used by rigs without engine.js.
const FORCE_PER_HP = 0;
const ANGULAR_DAMPING = 0.15; // bleeds residual spin so bumps don't build into tumbles
const WHEEL_HITBOX_PED_GROUP = 16; // pedestrians' collision group (pedestrians.js)
const WHEEL_HITBOX_SHAPE_GROUP = 32; // shape group knocked pedestrians ignore (pedestrians.js)

const DEFAULT_WHEEL_OPTIONS = {
  directionLocal: new CANNON.Vec3(0, -1, 0),
  suspensionStiffness: 35, // ~7cm static sag
  suspensionRestLength: 0.55,
  axleLocal: new CANNON.Vec3(-1, 0, 0),
  maxSuspensionTravel: 0.35, // must clear static sag with headroom, or the car leans stuck
};
const DEFAULT_TYRE_WIDTH_MM = 225;
const DEFAULT_TYRE_PROFILE = 45;

const vec3 = (v) => new CANNON.Vec3(v[0], v[1], v[2]);
const clampUnit = (v) => Math.max(-1, Math.min(1, v));

/**
 * Moves `mesh`'s children into an inner group (added back to `mesh`) so the
 * visible body can sink in water while `mesh` itself tracks the physics body.
 */
function wrapInSinkGroup(mesh) {
  const group = new THREE.Group();
  group.add(...mesh.children);
  mesh.add(group);
  mesh.userData.contentGroup = group; // headlights.js attaches flares here
  return group;
}

/**
 * Least-squares plane sink = a + b*x + c*z through wheel points (body-local
 * x/z) into `out`; flat (mean) when the points can't define a plane.
 */
function fitSinkPlane(wheels, sinks, out) {
  const n = wheels.length;
  let mx = 0;
  let mz = 0;
  let ms = 0;
  for (const w of wheels) {
    mx += w.x / n;
    mz += w.z / n;
    ms += sinks[w.index] / n;
  }
  // Centred normal equations for the two slopes.
  let xx = 0;
  let zz = 0;
  let xz = 0;
  let xs = 0;
  let zs = 0;
  for (const w of wheels) {
    const dx = w.x - mx;
    const dz = w.z - mz;
    const ds = sinks[w.index] - ms;
    xx += dx * dx;
    zz += dz * dz;
    xz += dx * dz;
    xs += dx * ds;
    zs += dz * ds;
  }
  const det = xx * zz - xz * xz;
  const flat = n < 3 || Math.abs(det) < 1e-6;
  out.b = flat ? 0 : (xs * zz - zs * xz) / det;
  out.c = flat ? 0 : (zs * xx - xs * xz) / det;
  out.a = n ? ms - out.b * mx - out.c * mz : 0;
  return out;
}

/**
 * addWheel options shared by every wheel on one body. `spec` holds the tyre +
 * suspension fields (a vehicle descriptor, or a trailer spec).
 */
function wheelOptionsFor(spec, bodyMass, wheelCount) {
  const tyreWidth = (spec.tyre ?? DEFAULT_TYRE_WIDTH_MM) / 1000;
  const suspension = { ...DEFAULT_WHEEL_OPTIONS, ...spec.suspension };
  const share = REFERENCE_WHEEL_COUNT / wheelCount;
  const scaled = (v) => (v === undefined ? v : v * share);
  return {
    ...suspension,
    radius: wheelRadiusOf(spec),
    tyreWidth,
    sidewallHeight: (tyreWidth * (spec.profile ?? DEFAULT_TYRE_PROFILE)) / 100,
    suspensionStiffness: scaled(suspension.suspensionStiffness),
    dampingCompression: scaled(suspension.dampingCompression),
    dampingRelaxation: scaled(suspension.dampingRelaxation),
    maxSuspensionForce: ((bodyMass * GRAVITY) / wheelCount) * (spec.suspensionForceG ?? DEFAULT_SUSPENSION_FORCE_G),
    staticLoadN: (bodyMass * GRAVITY) / wheelCount, // tyre wear scale (tyres.js)
  };
}

/** Wheel positions on one body, each with its addWheel options and mesh spec. */
function mountWheels(spec, body, axles, labelPrefix) {
  const attachY = spec.wheelAttachY ?? -CHASSIS_HEIGHT / 2;
  const layout = layoutWheels(axles, attachY, labelPrefix);
  const options = wheelOptionsFor(spec, body.mass, layout.length);
  const brakeForce = spec.brakeForce ?? DEFAULT_BRAKE_FORCE;
  return layout.map((w) => {
    if (!w.axle.wheel) return { ...w, body, spec, options, brakeForce };
    const wheelSpec = { ...spec, ...w.axle.wheel };
    return { ...w, body, spec: wheelSpec, options: wheelOptionsFor(wheelSpec, body.mass, layout.length), brakeForce };
  });
}

/**
 * cannon-es inertia from the real footprint (track x ground drop x length).
 * `extraZ`: other points that count for the length (a trailer's kingpin).
 */
function applyWheelFootprintInertia(body, wheels, extraZ = []) {
  const zs = [...wheels.map((w) => w.z), ...extraZ];
  const { options } = wheels[0];
  const groundDrop = -wheels[0].y + options.suspensionRestLength + options.radius;
  const halfTrack = Math.max(...wheels.map((w) => Math.abs(w.x)));
  applyFootprintInertia(body, new CANNON.Vec3(halfTrack, groundDrop, Math.max(...zs) - Math.min(...zs)));
  body.angularDamping = ANGULAR_DAMPING;
}

/**
 * Per-wheel pedal-brake scale putting `bias` of it on the axles ahead of the
 * wheelbase midpoint; total pedal force is unchanged.
 */
function pedalBiasScales(wheels, bias) {
  const zs = wheels.map((w) => w.z);
  const midZ = (Math.max(...zs) + Math.min(...zs)) / 2;
  const front = wheels.filter((w) => w.z > midZ + 1e-3).length;
  const rear = wheels.filter((w) => w.z < midZ - 1e-3).length;
  if (!front || !rear) return wheels.map(() => 1);
  const n = front + rear;
  return wheels.map((w) => (w.z > midZ + 1e-3 ? (bias * n) / front : w.z < midZ - 1e-3 ? ((1 - bias) * n) / rear : 1));
}

/** Trailer spec: tyre/suspension/brake fields fall back to the tractor's. */
function trailerSpecOf(descriptor) {
  const { rimSize, tyre, profile, rimColor, wheelRadius, suspension, suspensionForceG, brakeForce } = descriptor;
  return { rimSize, tyre, profile, rimColor, wheelRadius, suspension, suspensionForceG, brakeForce, ...descriptor.trailer };
}

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
  const hitbox = fitChassisHitbox(chassisMesh, descriptor.groundSpheres);
  const chassisBody = createChassisBody(chassisMass, startPosition, startQuaternion, hitbox);

  // Custom raycast vehicle (wheeledVehicle.js) instead of CANNON.RaycastVehicle.
  const vehicle = createWheeledVehicle({ chassisBody, indexRightAxis: 0, indexUpAxis: 1, indexForwardAxis: 2 });

  const axles = resolveAxles(descriptor.axles);
  const tractorWheels = mountWheels(descriptor, chassisBody, axles, '');
  applyWheelFootprintInertia(chassisBody, tractorWheels);

  // --- Optional articulated trailer: own body, wheels in the same rig ---
  let trailer = null;
  if (descriptor.trailer) {
    const spec = trailerSpecOf(descriptor);
    const { group: mesh } = spec.buildBody(color);
    const trailerHitbox = fitChassisHitbox(mesh, spec.groundSpheres);
    const body = createChassisBody(spec.mass ?? DEFAULT_TRAILER_MASS, startPosition, startQuaternion, trailerHitbox);
    const hitchLocal = vec3(spec.hitch);
    const kingpinLocal = vec3(spec.kingpin);
    placeTrailer(chassisBody, body, hitchLocal, kingpinLocal);
    const wheels = mountWheels(spec, body, resolveAxles(spec.axles), 'T');
    applyWheelFootprintInertia(body, wheels, [kingpinLocal.z]);
    trailer = { spec, mesh, hitbox: trailerHitbox, body, hitchLocal, kingpinLocal, wheels, hitch: null };
  }
  const allWheels = [...tractorWheels, ...(trailer?.wheels ?? [])];

  const rearSlideGrip = descriptor.rearSlideGrip ?? DEFAULT_REAR_SLIDE_GRIP;
  for (const w of allWheels) {
    vehicle.addWheel({
      ...w.options,
      slideGripScale: w.body === chassisBody && !w.axle.steer ? rearSlideGrip : 1,
      width: wheelSetWidth(w.options.tyreWidth, w.axle.dual),
      body: w.body,
      chassisConnectionPointLocal: new CANNON.Vec3(w.x, w.y, w.z),
    });
  }
  vehicle.addToWorld(world);
  if (trailer) {
    world.addBody(trailer.body);
    trailer.hitch = createTrailerHitch(world, chassisBody, trailer.body, {
      hitchLocal: trailer.hitchLocal,
      kingpinLocal: trailer.kingpinLocal,
      maxArticulation: trailer.spec.maxArticulation,
    });
    vehicle.ignoreBodies.push(trailer.body);
    vehicle.extraBodies = [trailer.body];
    vehicle.tunnelGuardBodies = [chassisBody, trailer.body];
  }

  const wheelRadius = (tractorWheels.find((w) => w.axle.driven) ?? tractorWheels[0]).options.radius;
  vehicle.vehicleType = descriptor.vehicleType;
  vehicle.wheelLabels = allWheels.map((w) => w.label);
  vehicle.engineForce = descriptor.enginePowerHp * FORCE_PER_HP;
  vehicle.engine = createEngineState(descriptor, wheelRadius); // rpm/gearbox, driven by input.js
  vehicle.fuel = createFuelTank(descriptor, chassisBody); // burnt by mainLoop, adds its mass to the chassis
  Object.defineProperty(vehicle.engine, 'fuelFraction', { get: () => vehicle.fuel.fraction });
  vehicle.driveWheels = tractorWheels.flatMap((w, i) => (w.axle.driven ? [i] : [])); // indices into wheelInfos
  vehicle.brakeForce = descriptor.brakeForce ?? DEFAULT_BRAKE_FORCE;
  vehicle.hasTrailer = !!trailer;
  vehicle.abs = descriptor.abs ?? DEFAULT_ABS; // ABS fitted: pedal brake backs off before locking
  vehicle.absOff = false; // fitted ABS switched off from the dash lamp
  vehicle.tractionControl = descriptor.tractionControl ?? false; // dash lamp only, not simulated
  // Speed-sensitive steering lock; input.js lerps between these by speed.
  vehicle.steerSpeedD = descriptor.steerSpeedD ?? DEFAULT_STEER_SPEED_D;
  vehicle.maxSteerAt0 = descriptor.maxSteerAt0 ?? MAX_STEER;
  vehicle.maxSteerAt100 = descriptor.maxSteerAt100 ?? MAX_STEER;

  // Steer input = front-axle centreline angle; every steered wheel follows the shared turn centre.
  const steering = createSteeringGeometry(axles, descriptor);
  const steerAngles = new Array(tractorWheels.length).fill(0);
  vehicle.steerInput = 0;
  vehicle.applySteer = (value, speedKmh = 0) => {
    vehicle.steerInput = value;
    steering.angles(value, speedKmh, tractorWheels, steerAngles);
    for (let i = 0; i < steerAngles.length; i++) vehicle.wheelInfos[i].steering = steerAngles[i];
  };
  const pedalBias = pedalBiasScales(tractorWheels, descriptor.brakeBias ?? DEFAULT_BRAKE_BIAS);
  // Pedal brake on every wheel, handbrake only on handbrake axles (they must be able to lock).
  vehicle.applyBrakes = (pedalForce, handbrakeForce, abs) => {
    allWheels.forEach((w, i) => {
      const share = w.brakeForce / vehicle.brakeForce;
      const handbrake = w.axle.handbrake ? handbrakeForce : 0;
      const pedal = pedalForce * (pedalBias[i] ?? 1);
      vehicle.setBrake(Math.max(pedal, handbrake) * share, i, abs && !handbrake, handbrake > 0);
    });
  };

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
  const wheelHitboxBodies = allWheels.map((w) => {
    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.KINEMATIC,
      collisionFilterGroup: 1,
      collisionFilterMask: WHEEL_HITBOX_PED_GROUP,
    });
    const sphere = new CANNON.Sphere(w.options.radius);
    sphere.collisionFilterGroup = WHEEL_HITBOX_SHAPE_GROUP;
    body.addShape(sphere);
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

  const dragProfile = descriptor.dragProfile ?? DEFAULT_DRAG_PROFILE;
  const trailerDragProfile = trailer?.spec.dragProfile ?? DEFAULT_DRAG_PROFILE;
  const trailerForward = new CANNON.Vec3();
  const stabilityAssistCallback = () => {
    chassisBody.vectorToWorldFrame(forwardLocal, forwardWorld);
    applyAirDrag(chassisBody, forwardWorld, dragProfile);
    applyWaterDrag(chassisBody, vehicle.waterDepth);
    if (trailer) {
      trailer.body.vectorToWorldFrame(forwardLocal, trailerForward);
      applyAirDrag(trailer.body, trailerForward, trailerDragProfile);
      applyWaterDrag(trailer.body, vehicle.waterDepth);
    }
  };
  world.addEventListener('preStep', stabilityAssistCallback);

  // --- Meshes ---
  scene.add(chassisMesh);
  // Before the hitbox meshes, so those stay on the physics pose.
  const sinkGroups = [wrapInSinkGroup(chassisMesh)];
  if (trailer) sinkGroups.push(wrapInSinkGroup(trailer.mesh));
  const hitboxMeshes = buildChassisHitboxMeshes(chassisMesh, hitbox);
  if (trailer) {
    scene.add(trailer.mesh);
    hitboxMeshes.push(...buildChassisHitboxMeshes(trailer.mesh, trailer.hitbox));
  }
  function setHitboxVisible(visible) {
    for (const m of hitboxMeshes) m.visible = visible;
  }
  const wheelMeshes = allWheels.map((w) => buildWheelSet(w.spec, scene, w.axle.dual));
  const wheelMeshFlat = allWheels.map(() => false);

  // --- Render interpolation ---
  // Physics runs at a fixed step; render lerps between the last two steps
  // so a varying substep count per frame doesn't show as jitter.
  const tracked = [{ body: chassisBody, mesh: chassisMesh }];
  if (trailer) tracked.push({ body: trailer.body, mesh: trailer.mesh });
  for (const t of tracked) {
    t.prevPos = new THREE.Vector3().copy(t.body.position);
    t.currPos = new THREE.Vector3().copy(t.body.position);
    t.prevQuat = new THREE.Quaternion().copy(t.body.quaternion);
    t.currQuat = new THREE.Quaternion().copy(t.body.quaternion);
  }
  const prevWheelPos = allWheels.map(() => new THREE.Vector3());
  const currWheelPos = allWheels.map(() => new THREE.Vector3());
  const prevWheelQuat = allWheels.map(() => new THREE.Quaternion());
  const currWheelQuat = allWheels.map(() => new THREE.Quaternion());

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
    for (const t of tracked) {
      t.prevPos.copy(t.currPos);
      t.prevQuat.copy(t.currQuat);
      t.currPos.copy(t.body.position);
      t.currQuat.copy(t.body.quaternion);
    }
    for (let i = 0; i < allWheels.length; i++) {
      prevWheelPos[i].copy(currWheelPos[i]);
      prevWheelQuat[i].copy(currWheelQuat[i]);
    }
    readWheelTransforms(currWheelPos, currWheelQuat);
  }

  /** Sets prev = curr = now, so a teleport doesn't interpolate. */
  function resetInterpolation() {
    for (const t of tracked) {
      t.currPos.copy(t.body.position);
      t.currQuat.copy(t.body.quaternion);
      t.prevPos.copy(t.currPos);
      t.prevQuat.copy(t.currQuat);
    }
    readWheelTransforms(currWheelPos, currWheelQuat);
    for (let i = 0; i < allWheels.length; i++) {
      prevWheelPos[i].copy(currWheelPos[i]);
      prevWheelQuat[i].copy(currWheelQuat[i]);
    }
  }

  // Per-wheel visual sink (m, world down), set each frame by waterImmersion.js.
  // Each body tilts through the plane of its own wheels' sinks.
  vehicle.wheelSinks = allWheels.map(() => 0);
  const sinkWheelsByBody = tracked.map((t) =>
    allWheels.flatMap((w, index) => (w.body === t.body ? [{ x: w.x, z: w.z, index }] : []))
  );
  const sinkPlane = { a: 0, b: 0, c: 0 };
  const sinkQuat = new THREE.Quaternion();
  const sinkEuler = new THREE.Euler();

  /** @param {number} alpha - 0..1 between previous and current physics step. */
  function syncMeshes(alpha = 1) {
    const sinks = vehicle.wheelSinks;
    tracked.forEach((t, i) => {
      t.mesh.position.lerpVectors(t.prevPos, t.currPos, alpha);
      t.mesh.quaternion.slerpQuaternions(t.prevQuat, t.currQuat, alpha);
      const { a, b, c } = fitSinkPlane(sinkWheelsByBody[i], sinks, sinkPlane);
      const group = sinkGroups[i];
      // Centre drop: world-down offset expressed in the body's local frame.
      group.position.set(0, -a, 0).applyQuaternion(sinkQuat.copy(t.mesh.quaternion).invert());
      // Tilt so a local point (x, z) drops by b*x + c*z (pitch about x, roll about z).
      group.quaternion.setFromEuler(sinkEuler.set(Math.asin(clampUnit(c)), 0, -Math.asin(clampUnit(b))));
    });
    wheelMeshes.forEach((mesh, i) => {
      const flat = vehicle.wheelInfos[i].punctured;
      if (flat !== wheelMeshFlat[i]) setWheelSetFlat(mesh, (wheelMeshFlat[i] = flat));
      mesh.position.lerpVectors(prevWheelPos[i], currWheelPos[i], alpha);
      mesh.position.y -= sinks[i];
      mesh.quaternion.slerpQuaternions(prevWheelQuat[i], currWheelQuat[i], alpha);
    });
  }

  // --- Reset ---
  // Without arguments: rights the car in place (same heading, lifted). Fits fresh tyres.
  // The body is kinematic while updateReset() eases it into the pose; a
  // trailer rides along straight behind it.
  let liftAnim = null;
  const resetLift = descriptor.resetLift ?? CHASSIS_HEIGHT + 0.5;

  function setRigType(type) {
    chassisBody.type = type;
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    if (!trailer) return;
    trailer.body.type = type;
    placeTrailer(chassisBody, trailer.body, trailer.hitchLocal, trailer.kingpinLocal);
  }

  function reset(position, quaternion) {
    const targetPos = position ?? liftedResetPosition(world, chassisBody, resetLift);
    liftAnim = {
      startPos: chassisBody.position.clone(),
      startQuat: chassisBody.quaternion.clone(),
      targetPos,
      targetQuat: quaternion ?? uprightQuaternion(chassisBody),
      elapsed: 0,
    };
    setRigType(CANNON.Body.KINEMATIC);
    vehicle.resetWheelSpin();
    vehicle.repairTyres();
    resetInterpolation();
  }

  /** Call every render frame (wall-clock duration). */
  function updateReset(dt) {
    if (!liftAnim) return;
    liftAnim.elapsed += dt;
    const { t, eased } = resetLiftProgress(liftAnim.elapsed);
    liftAnim.startPos.lerp(liftAnim.targetPos, eased, chassisBody.position);
    liftAnim.startQuat.slerp(liftAnim.targetQuat, eased, chassisBody.quaternion);
    if (trailer) placeTrailer(chassisBody, trailer.body, trailer.hitchLocal, trailer.kingpinLocal);
    if (t >= 1) {
      setRigType(CANNON.Body.DYNAMIC);
      vehicle.resetWheelSpin();
      liftAnim = null;
    }
  }

  /** Floating-origin shift of the state carManager's generic body/scene shift can't see. */
  function shiftOrigin(dx, dz) {
    shiftPoints([...tracked.flatMap((t) => [t.prevPos, t.currPos]), ...prevWheelPos, ...currWheelPos], dx, dz);
    if (liftAnim) shiftPoints([liftAnim.startPos, liftAnim.targetPos], dx, dz);
  }

  /** Removes the extras carManager's generic cleanup doesn't know about. */
  function dispose() {
    world.removeEventListener('preStep', syncWheelHitboxes);
    for (const body of wheelHitboxBodies) world.removeBody(body);
    if (trailer) {
      trailer.hitch.dispose();
      world.removeBody(trailer.body);
      scene.remove(trailer.mesh);
    }
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
    isResetting: () => liftAnim !== null,
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
