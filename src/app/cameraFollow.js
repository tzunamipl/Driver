import * as THREE from 'three';
import {
  CAMERA_OFFSET,
  CAMERA_LOOKAT_OFFSET,
  CAMERA_POSITION_SPEED,
  CAMERA_LOOKAT_SPEED,
  CAMERA_YAW_SPEED,
  FLIP_UP_DOT_THRESHOLD,
  CAMERA_MIN_SPEED_FOR_VELOCITY_YAW,
  CAMERA_CLOSE_MIN_SPEED,
  CAMERA_CLOSE_MAX_SPEED,
  CAMERA_CLOSE_SCALE_AT_MIN_SPEED,
  CAMERA_CLOSE_SCALE_AT_MAX_SPEED,
  CAMERA_POSITION_LEAD_FACTOR,
  CAMERA_ACCEL_LAG,
  CAMERA_ACCEL_LAG_MAX,
  CAMERA_ACCEL_LEAD_MAX,
  CAMERA_ACCEL_LAG_RATE,
  CAMERA_PITCH_SPEED,
  CAMERA_PITCH_MAX_ANGLE,
  CAMERA_PITCH_MIN_SPEED,
  CAMERA_GROUND_CLEARANCE_M,
  TELEPORT_CAMERA_FOV_DEG,
  TELEPORT_CAMERA_ORBIT_RATE,
  TELEPORT_CAMERA_SPIN_UP_S,
  TELEPORT_CAMERA_SPIN_DOWN_S,
  TELEPORT_CAMERA_ROLL_DEG,
  TELEPORT_CAMERA_JUMP_FOV_DEG,
  TELEPORT_CAMERA_JUMP_WOBBLE_S,
  TELEPORT_CAMERA_JUMP_WOBBLE_HZ,
  TELEPORT_CAMERA_ORBIT_RADIUS,
  TELEPORT_CAMERA_ORBIT_HEIGHT,
  TELEPORT_CAMERA_BLEND_IN_S,
  TELEPORT_CAMERA_BLEND_OUT_S,
  TELEPORT_CAMERA_MIN_S,
  TELEPORT_CAMERA_SETTLE_S,
} from '../config.js';
import { CAMERA_VIEWS, getCameraView, nextCameraView, viewMatchesVehicle, DEFAULT_CAMERA_VIEW_ID } from './cameraViews/index.js';
import { createCameraListHud } from '../hud/cameraListHud.js';
import { getVehicle } from '../lib/vehicles/index.js';
import { readSaveField, writeSaveField } from '../lib/saves.js';

// Chase camera: aims along the velocity (not facing), smooths yaw to
// filter suspension jitter, freezes yaw while flipped, and tilts slightly
// on sustained climbs/falls. Views (app/cameraViews/, cycled with C)
// override the shared CAMERA_* defaults; `rigid` views mount directly on
// the vehicle instead. Teleports swap in a wide orbit round the car until
// it has landed at the destination.

function isTypingInField() {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'range' && el.type !== 'color');
}

function loadSavedViewId() {
  const id = readSaveField('cameraView');
  return CAMERA_VIEWS.some((v) => v.id === id) ? id : null;
}

/**
 * Returns updateCamera(delta, { chassisMesh, podMesh, vehicle, vehicleId, teleporting, resetting }),
 * groundHeightAt(x, z) -> y | null keeps the drone view above terrain and roofs,
 * terrainHeightAt(x, z) -> y | null keeps every view above the terrain;
 * with .cycleView/.setView/.holdView/.releaseView/.getViewId/.getViews attached.
 */
export function createCameraFollow(camera, { groundHeightAt = () => null, terrainHeightAt = () => null } = {}) {
  const tmpVec = new THREE.Vector3();
  const tmpOffsetVec = new THREE.Vector3();
  const tmpLookOffsetVec = new THREE.Vector3();
  const tmpForward = new THREE.Vector3();
  const tmpCarUp = new THREE.Vector3();
  const tmpLeadPos = new THREE.Vector3();
  const tmpLeadLook = new THREE.Vector3();
  const yawQuat = new THREE.Quaternion();
  const pitchQuat = new THREE.Quaternion();
  const rotQuat = new THREE.Quaternion();
  const rightVec = new THREE.Vector3(1, 0, 0);
  const upVec = new THREE.Vector3(0, 1, 0);
  const smoothedLookAt = new THREE.Vector3();
  let smoothedLookAtInit = false;
  let lastYaw = 0;
  let smoothedYaw = 0;
  let smoothedYawInit = false;
  let smoothedPitch = 0;
  let smoothedPitchInit = false;
  let smoothedCloseScale = 1;
  let laggedSpeed = null; // trails the horizontal speed; the gap drives the accel lag
  const tmpAccelLag = new THREE.Vector3();
  let droneSweep = null; // side-to-side sweep phase; null = just switched to the drone

  let viewId = loadSavedViewId() ?? DEFAULT_CAMERA_VIEW_ID;
  const cameraList = createCameraListHud();
  // Current vehicle's vehicleType, refreshed each frame, used to filter
  // vehicle-specific views. null = not known yet (matches any view).
  let currentVehicleType = null;

  /** Active view merged over the shared CAMERA_* defaults. */
  function activeParams() {
    const view = getCameraView(viewId, currentVehicleType);
    return {
      view,
      offset: view.offset ?? CAMERA_OFFSET,
      lookAtOffset: view.lookAtOffset ?? CAMERA_LOOKAT_OFFSET,
      positionSpeed: view.positionSpeed ?? CAMERA_POSITION_SPEED,
      lookAtSpeed: view.lookAtSpeed ?? CAMERA_LOOKAT_SPEED,
      closeScaleAtMaxSpeed: view.closeScaleAtMaxSpeed ?? CAMERA_CLOSE_SCALE_AT_MAX_SPEED,
      positionLeadFactor: view.positionLeadFactor ?? CAMERA_POSITION_LEAD_FACTOR,
      accelLag: view.accelLag ?? CAMERA_ACCEL_LAG,
      accelLagMax: view.accelLagMax ?? CAMERA_ACCEL_LAG_MAX,
      accelLeadMax: view.accelLeadMax ?? CAMERA_ACCEL_LEAD_MAX,
      accelLagRate: view.accelLagRate ?? CAMERA_ACCEL_LAG_RATE,
    };
  }

  /** Next frame snaps to the new view instead of lerping across the cut. */
  function resetSmoothing() {
    smoothedLookAtInit = false;
    smoothedYawInit = false;
    smoothedPitchInit = false;
    smoothedCloseScale = 1;
    laggedSpeed = null;
    droneSweep = null;
  }

  function setView(id) {
    const view = getCameraView(id, currentVehicleType);
    viewId = view.id;
    resetSmoothing();
    writeSaveField('cameraView', viewId);
    cameraList.show(
      CAMERA_VIEWS.filter((v) => viewMatchesVehicle(v, currentVehicleType)),
      viewId
    );
  }

  // View to go back to after holdView(); null when not held.
  let heldFrom = null;

  /** Switches to `id` for a while (not saved); releaseView() returns to the previous view. */
  function holdView(id) {
    if (heldFrom == null) heldFrom = viewId;
    viewId = getCameraView(id, currentVehicleType).id;
    resetSmoothing();
  }

  function releaseView() {
    if (heldFrom == null) return;
    viewId = getCameraView(heldFrom, currentVehicleType).id;
    heldFrom = null;
    resetSmoothing();
  }

  function cycleView() {
    setView(nextCameraView(viewId, currentVehicleType).id);
  }

  window.addEventListener('keydown', (e) => {
    if (isTypingInField()) return;
    if (e.code === 'KeyC' && !e.repeat) cycleView();
  });

  /** Camera fixed to `mountMesh`, aimed along `lookAtMesh` (default: the mount). */
  function updateRigid(view, mountMesh, lookAtMesh) {
    tmpVec.set(...(view.offset ?? [0, 1.3, 1.6])).applyQuaternion(mountMesh.quaternion).add(mountMesh.position);
    camera.position.copy(tmpVec);
    const targetMesh = lookAtMesh ?? mountMesh;
    tmpVec
      .set(...(view.lookAtOffset ?? [0, 1, 10]))
      .applyQuaternion(targetMesh.quaternion)
      .add(targetMesh.position);
    camera.up.set(0, 1, 0).applyQuaternion(mountMesh.quaternion);
    camera.lookAt(tmpVec);
  }

  const droneVel = new THREE.Vector3();
  const droneTmp = new THREE.Vector3();
  const droneLookOffset = new THREE.Vector3();
  // Lagged picture of the car the drone flies by: velocity, heading,
  // and position kept as an offset from the car (no floating-origin shift needed).
  const droneRefVel = new THREE.Vector3();
  const droneRefOffset = new THREE.Vector3();
  const droneRefPos = new THREE.Vector3();
  let droneRefYaw = 0;
  let droneTime = 0;
  // Random phases so each session wanders differently.
  const dronePhases = Array.from({ length: 15 }, () => Math.random() * Math.PI * 2);
  /** Smooth pseudo-random signal in [-1, 1] from three incommensurate slow sines. */
  function droneNoise(channel) {
    const p = dronePhases;
    const i = channel * 3;
    return (
      Math.sin(droneTime * 0.13 + p[i]) * 0.5 +
      Math.sin(droneTime * 0.071 + p[i + 1]) * 0.3 +
      Math.sin(droneTime * 0.037 + p[i + 2]) * 0.2
    );
  }

  /** Free-flying drone steered toward a point sweeping round the car; speed narrows the sweep behind it. */
  function updateDrone(delta, view, carPos, vel, cameraScale, lookAtSpeed) {
    droneTime += delta;

    if (droneSweep === null) {
      droneSweep = Math.random() * Math.PI * 2;
      droneVel.set(vel.x, vel.y, vel.z); // take off from wherever the previous view left the camera
      droneRefVel.set(vel.x, vel.y, vel.z);
      droneRefOffset.set(0, 0, 0);
      droneRefYaw = smoothedYaw;
    }

    // Reacts to the car about `reactionTime` late: velocity and heading ease toward the
    // car's, the reference position runs on that velocity and drifts back onto the car.
    const react = 1 - Math.exp(-delta / view.reactionTime);
    droneRefOffset.x += (droneRefVel.x - vel.x) * delta;
    droneRefOffset.y += (droneRefVel.y - vel.y) * delta;
    droneRefOffset.z += (droneRefVel.z - vel.z) * delta;
    droneRefOffset.multiplyScalar(1 - react);
    droneRefVel.x += (vel.x - droneRefVel.x) * react;
    droneRefVel.y += (vel.y - droneRefVel.y) * react;
    droneRefVel.z += (vel.z - droneRefVel.z) * react;
    droneRefYaw += Math.atan2(Math.sin(smoothedYaw - droneRefYaw), Math.cos(smoothedYaw - droneRefYaw)) * react;
    const refPos = droneRefPos.copy(carPos).add(droneRefOffset);

    const speed = Math.hypot(droneRefVel.x, droneRefVel.z);
    const follow = THREE.MathUtils.smoothstep(speed, view.followMinSpeed, view.followMaxSpeed);

    // Keeps sweeping from one side of the car to the other at a drifting pace,
    // around the rear when fast, all the way round to the front when slow.
    droneSweep += view.sweepRate * (1 + 0.5 * droneNoise(0)) * delta;
    const swing =
      THREE.MathUtils.lerp(view.sideSwingSlow, view.sideSwingFast, follow) * (0.8 + 0.2 * droneNoise(4));
    const angle = droneRefYaw + Math.PI + swing * Math.sin(droneSweep);

    // Occasional swoop: this channel's peaks bring it low and close.
    const swoop = THREE.MathUtils.smoothstep(droneNoise(3), 0.35, 0.75);
    const radius =
      THREE.MathUtils.lerp(view.orbitRadius, view.followDistance, follow) *
      (1 + view.radiusWander * droneNoise(1)) *
      THREE.MathUtils.lerp(1, view.swoopRadius, swoop) *
      cameraScale;
    const height = THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(view.orbitHeight, view.followHeight, follow) * (1 + view.heightWander * droneNoise(2)) * cameraScale,
      view.swoopHeight,
      swoop
    );
    const target = tmpVec.set(Math.sin(angle) * radius, height, Math.cos(angle) * radius).add(refPos);

    // Respawn/teleport or first use from far away: jump there.
    if (camera.position.distanceToSquared(target) > 300 * 300) {
      droneRefOffset.set(0, 0, 0);
      droneRefVel.set(vel.x, vel.y, vel.z);
      target.set(Math.sin(angle) * radius, height, Math.cos(angle) * radius).add(carPos);
      camera.position.copy(target);
      droneVel.set(vel.x, vel.y, vel.z);
    }

    // Steers toward the target on its own; only at speed does it inherit the car's velocity
    // (else it couldn't keep up). Acceleration-limited so it drifts like a body.
    const desired = droneTmp.subVectors(target, camera.position).multiplyScalar(view.steer);
    desired.clampLength(0, view.maxOwnSpeed);
    const carry = THREE.MathUtils.lerp(view.carryMin, 1, THREE.MathUtils.smoothstep(speed, 0, view.carryFullSpeed));
    desired.x += droneRefVel.x * carry;
    desired.y += droneRefVel.y * carry;
    desired.z += droneRefVel.z * carry;
    const accel = desired.sub(droneVel).clampLength(0, view.maxAccel * delta);
    droneVel.add(accel);
    camera.position.addScaledVector(droneVel, delta);
    // Ground under it and slightly ahead along its flight, so it climbs before a slope.
    const pos = camera.position;
    const groundHere = groundHeightAt(pos.x, pos.z);
    const groundAhead = groundHeightAt(pos.x + droneVel.x * 0.5, pos.z + droneVel.z * 0.5);
    const ground = Math.max(groundHere ?? -Infinity, groundAhead ?? -Infinity);
    const floor = (Number.isFinite(ground) ? ground : carPos.y) + view.groundClearance;
    if (pos.y < floor) {
      camera.position.y = floor;
      if (droneVel.y < 0) droneVel.y = 0;
    }

    // Aim at the car, shifting ahead along its travel as follow rises. Only the
    // offset from the car is smoothed, so the aim never lags a falling car.
    const lookOffset = tmpLeadLook.set(Math.sin(droneRefYaw), 0, Math.cos(droneRefYaw));
    lookOffset.multiplyScalar(view.lookAhead * follow * cameraScale);
    lookOffset.y += 1;
    if (!smoothedLookAtInit) {
      droneLookOffset.copy(lookOffset);
      smoothedLookAtInit = true;
    } else {
      droneLookOffset.lerp(lookOffset, 1 - Math.exp(-lookAtSpeed * delta));
    }
    smoothedLookAt.copy(carPos).add(droneLookOffset);
    camera.up.set(0, 1, 0);
    camera.lookAt(smoothedLookAt);
  }

  function updateView(delta, chassisMesh, podMesh, vehicle, descriptor) {
    currentVehicleType = descriptor?.vehicleType; // vehicle can change mid-drive
    const {
      view, offset, lookAtOffset, positionSpeed, lookAtSpeed, closeScaleAtMaxSpeed, positionLeadFactor,
      accelLag, accelLagMax, accelLeadMax, accelLagRate,
    } = activeParams();

    if (view.rigid) {
      // mountPoint 'pod': ride the chariot's pod; lookAtTarget 'chassis':
      // aim at the centre engine (the pod's own facing lags it).
      const mountMesh = view.mountPoint === 'pod' && podMesh ? podMesh : chassisMesh;
      const lookAtMesh = view.lookAtTarget === 'chassis' ? chassisMesh : null;
      // Big vehicles move rigid mounts (cab height) via descriptor.cameraMounts[viewId].
      updateRigid({ ...view, ...descriptor?.cameraMounts?.[view.id] }, mountMesh, lookAtMesh);
      return;
    }

    // Chase views pull back for long vehicles (descriptor.cameraScale).
    const cameraScale = descriptor?.cameraScale ?? 1;
    const cameraOffset = tmpOffsetVec.set(offset[0], offset[1], offset[2]).multiplyScalar(cameraScale);
    const cameraLookOffset = tmpLookOffsetVec.set(lookAtOffset[0], lookAtOffset[1], lookAtOffset[2]).multiplyScalar(cameraScale);

    const carPos = chassisMesh.position;
    const carQuat = chassisMesh.quaternion;

    tmpCarUp.set(0, 1, 0).applyQuaternion(carQuat);
    const isFlipped = tmpCarUp.dot(upVec) < FLIP_UP_DOT_THRESHOLD;

    let yaw = lastYaw;
    if (!isFlipped) {
      // Horizontal velocity direction (so drifts/reversing frame right);
      // chassis facing when too slow. Never pitch/roll from the chassis.
      const vel = vehicle.chassisBody.velocity;
      tmpForward.set(vel.x, 0, vel.z);
      if (tmpForward.lengthSq() < CAMERA_MIN_SPEED_FOR_VELOCITY_YAW * CAMERA_MIN_SPEED_FOR_VELOCITY_YAW) {
        tmpForward.set(0, 0, 1).applyQuaternion(carQuat);
        tmpForward.y = 0;
      }
      if (tmpForward.lengthSq() < 1e-8) tmpForward.set(0, 0, 1);
      tmpForward.normalize();
      yaw = Math.atan2(tmpForward.x, tmpForward.z);
      lastYaw = yaw;
    }

    // Smooth the yaw angle itself (shortest path).
    if (!smoothedYawInit) {
      smoothedYaw = yaw;
      smoothedYawInit = true;
    } else {
      const yawDiff = Math.atan2(Math.sin(yaw - smoothedYaw), Math.cos(yaw - smoothedYaw));
      const yawFactor = 1 - Math.exp(-CAMERA_YAW_SPEED * delta);
      smoothedYaw += yawDiff * yawFactor;
    }
    yawQuat.setFromAxisAngle(upVec, smoothedYaw);

    if (view.drone) {
      updateDrone(delta, view, carPos, vehicle.chassisBody.velocity, cameraScale, lookAtSpeed);
      return;
    }

    // Pitch from the velocity's slope, clamped and smoothed; level when slow.
    const vel = vehicle.chassisBody.velocity;
    const horizSpeed = Math.hypot(vel.x, vel.z);
    let pitchTarget = 0;
    if (horizSpeed >= CAMERA_PITCH_MIN_SPEED) {
      pitchTarget = THREE.MathUtils.clamp(
        -Math.atan2(vel.y, horizSpeed),
        -CAMERA_PITCH_MAX_ANGLE,
        CAMERA_PITCH_MAX_ANGLE
      );
    }
    if (!smoothedPitchInit) {
      smoothedPitch = pitchTarget;
      smoothedPitchInit = true;
    } else {
      const pitchFactor = 1 - Math.exp(-CAMERA_PITCH_SPEED * delta);
      smoothedPitch += (pitchTarget - smoothedPitch) * pitchFactor;
    }
    pitchQuat.setFromAxisAngle(rightVec, smoothedPitch); // around the yawed right axis
    rotQuat.copy(yawQuat).multiply(pitchQuat);

    // Frame-rate independent exponential smoothing.
    const posFactor = 1 - Math.exp(-positionSpeed * delta);
    const lookFactor = 1 - Math.exp(-lookAtSpeed * delta);

    // Closer when slow, wider when fast.
    const speed = vel.length();
    const speedT = THREE.MathUtils.clamp(
      (speed - CAMERA_CLOSE_MIN_SPEED) / (CAMERA_CLOSE_MAX_SPEED - CAMERA_CLOSE_MIN_SPEED),
      0,
      1
    );
    const targetCloseScale = THREE.MathUtils.lerp(
      CAMERA_CLOSE_SCALE_AT_MIN_SPEED,
      closeScaleAtMaxSpeed,
      speedT
    );
    smoothedCloseScale += (targetCloseScale - smoothedCloseScale) * posFactor;

    // Lead the targets by velocity * settling time (1/speed) to cancel the
    // smoothing's steady-state lag.
    tmpLeadPos
      .set(vel.x, vel.y, vel.z)
      .multiplyScalar((positionLeadFactor / positionSpeed));
    tmpLeadLook
      .set(vel.x, vel.y, vel.z)
      .multiplyScalar((positionLeadFactor / lookAtSpeed));

    // (speed - laggedSpeed) * rate is the low-passed acceleration: back while speeding up, in while braking.
    // tanh eases into the max instead of clipping, so harder (de)celeration always moves it more.
    if (laggedSpeed == null) laggedSpeed = horizSpeed;
    laggedSpeed += (horizSpeed - laggedSpeed) * (1 - Math.exp(-accelLagRate * delta));
    const rawLagM = (horizSpeed - laggedSpeed) * accelLagRate * accelLag;
    const lagMaxM = rawLagM >= 0 ? accelLagMax : accelLeadMax;
    const lagM = lagMaxM * Math.tanh(rawLagM / lagMaxM);
    tmpAccelLag.set(0, 0, -lagM).applyQuaternion(yawQuat);

    tmpVec
      .copy(cameraOffset)
      .multiplyScalar(smoothedCloseScale)
      .applyQuaternion(rotQuat)
      .add(carPos)
      .add(tmpLeadPos)
      .add(tmpAccelLag);
    camera.position.lerp(tmpVec, posFactor);

    const lookAt = cameraLookOffset
      .clone()
      .multiplyScalar(smoothedCloseScale)
      .applyQuaternion(rotQuat)
      .add(carPos)
      .add(tmpLeadLook);
    if (!smoothedLookAtInit) {
      smoothedLookAt.copy(lookAt);
      smoothedLookAtInit = true;
    } else {
      smoothedLookAt.lerp(lookAt, lookFactor);
    }
    camera.lookAt(smoothedLookAt);
    camera.up.set(0, 1, 0);
  }

  function keepAboveTerrain(pos) {
    const ground = terrainHeightAt(pos.x, pos.z);
    if (ground != null && pos.y < ground + CAMERA_GROUND_CLEARANCE_M) pos.y = ground + CAMERA_GROUND_CLEARANCE_M;
  }

  // Teleport orbit. The selected view keeps running underneath on its own
  // pose (viewPos/viewQuat) and the orbit is blended over it by `weight`.
  const baseFov = camera.fov;
  const viewPos = new THREE.Vector3();
  const viewQuat = new THREE.Quaternion();
  const orbitPos = new THREE.Vector3();
  const orbitLook = new THREE.Vector3();
  const orbitQuat = new THREE.Quaternion();
  const orbitMatrix = new THREE.Matrix4();
  const rollQuat = new THREE.Quaternion();
  const forwardAxis = new THREE.Vector3(0, 0, -1);
  let transition = null; // { elapsed, settled, weight, angle, rate, teleporting, sinceJump }

  /** Damped FOV wobble after the jump: starts at the full drop, rings and fades to 0 by the end. */
  function jumpFovOffset(t) {
    if (t >= TELEPORT_CAMERA_JUMP_WOBBLE_S) return 0;
    const u = t / TELEPORT_CAMERA_JUMP_WOBBLE_S;
    return TELEPORT_CAMERA_JUMP_FOV_DEG * Math.cos(2 * Math.PI * TELEPORT_CAMERA_JUMP_WOBBLE_HZ * t) * Math.exp(-3 * u) * (1 - u);
  }

  /** Starts on `teleporting`; holds until the car has been placed and settled, then blends back. */
  function updateTransition(delta, carPos, cameraScale, teleporting, resetting) {
    if (teleporting && !transition) {
      // Start the orbit where the camera already is, so it only widens and turns.
      tmpVec.subVectors(camera.position, carPos);
      transition = { elapsed: 0, settled: 0, weight: 0, angle: Math.atan2(tmpVec.x, tmpVec.z), rate: 0, teleporting: true, sinceJump: Infinity };
    }
    if (!transition) return;

    transition.elapsed += delta;
    if (transition.teleporting && !teleporting) transition.sinceJump = 0;
    else transition.sinceJump += delta;
    transition.teleporting = teleporting;
    transition.settled = teleporting || resetting ? 0 : transition.settled + delta;
    const holding = transition.elapsed < TELEPORT_CAMERA_MIN_S || transition.settled < TELEPORT_CAMERA_SETTLE_S;
    transition.weight = holding
      ? Math.min(1, transition.weight + delta / TELEPORT_CAMERA_BLEND_IN_S)
      : transition.weight - delta / TELEPORT_CAMERA_BLEND_OUT_S;
    if (transition.weight <= 0) {
      transition = null;
      camera.fov = baseFov;
      camera.updateProjectionMatrix();
      return;
    }
    viewPos.copy(camera.position);
    viewQuat.copy(camera.quaternion);

    transition.rate = holding
      ? Math.min(TELEPORT_CAMERA_ORBIT_RATE, transition.rate + (TELEPORT_CAMERA_ORBIT_RATE / TELEPORT_CAMERA_SPIN_UP_S) * delta)
      : Math.max(0, transition.rate - (TELEPORT_CAMERA_ORBIT_RATE / TELEPORT_CAMERA_SPIN_DOWN_S) * delta);
    transition.angle += transition.rate * delta;
    const radius = TELEPORT_CAMERA_ORBIT_RADIUS * cameraScale;
    orbitPos
      .set(Math.sin(transition.angle) * radius, TELEPORT_CAMERA_ORBIT_HEIGHT * cameraScale, Math.cos(transition.angle) * radius)
      .add(carPos);
    keepAboveTerrain(orbitPos);
    orbitLook.copy(carPos).y += 1;
    orbitQuat.setFromRotationMatrix(orbitMatrix.lookAt(orbitPos, orbitLook, upVec));
    const spin = THREE.MathUtils.smoothstep(transition.rate / TELEPORT_CAMERA_ORBIT_RATE, 0, 1);
    orbitQuat.multiply(rollQuat.setFromAxisAngle(forwardAxis, THREE.MathUtils.degToRad(TELEPORT_CAMERA_ROLL_DEG) * spin));

    const w = THREE.MathUtils.smoothstep(transition.weight, 0, 1);
    camera.position.lerp(orbitPos, w);
    camera.quaternion.slerp(orbitQuat, w);
    camera.fov = THREE.MathUtils.lerp(baseFov, TELEPORT_CAMERA_FOV_DEG, w) - jumpFovOffset(transition.sinceJump);
    camera.updateProjectionMatrix();
  }

  const updateCamera = function updateCamera(delta, { chassisMesh, podMesh, vehicle, vehicleId, teleporting = false, resetting = false }) {
    if (!chassisMesh || !vehicle) return;
    const descriptor = getVehicle(vehicleId);
    // Stateful views (chase smoothing, drone) continue from their own pose, not the blend.
    if (transition) {
      camera.position.copy(viewPos);
      camera.quaternion.copy(viewQuat);
    }
    updateView(delta, chassisMesh, podMesh, vehicle, descriptor);
    keepAboveTerrain(camera.position);
    updateTransition(delta, chassisMesh.position, descriptor?.cameraScale ?? 1, teleporting, resetting);
    keepAboveTerrain(camera.position);
  };

  /** Floating-origin shift (camera.position itself is moved by the caller). */
  updateCamera.shiftOrigin = (dx, dz) => {
    smoothedLookAt.x -= dx;
    smoothedLookAt.z -= dz;
    viewPos.x -= dx;
    viewPos.z -= dz;
  };
  updateCamera.cycleView = cycleView;
  updateCamera.setView = setView;
  updateCamera.holdView = holdView;
  updateCamera.releaseView = releaseView;
  updateCamera.getViewId = () => viewId;
  updateCamera.getViews = () => CAMERA_VIEWS;

  return updateCamera;
}
