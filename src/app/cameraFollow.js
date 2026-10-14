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
  CAMERA_PITCH_SPEED,
  CAMERA_PITCH_MAX_ANGLE,
  CAMERA_PITCH_MIN_SPEED,
  CAMERA_VIEW_STORAGE_KEY,
} from '../config.js';
import { CAMERA_VIEWS, getCameraView, nextCameraView, DEFAULT_CAMERA_VIEW_ID } from './cameraViews/index.js';
import { getVehicle } from '../lib/vehicles/index.js';

// Chase camera: aims along the velocity (not facing), smooths yaw to
// filter suspension jitter, freezes yaw while flipped, and tilts slightly
// on sustained climbs/falls. Views (app/cameraViews/, cycled with C)
// override the shared CAMERA_* defaults; `rigid` views mount directly on
// the vehicle instead.

function isTypingInField() {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'range' && el.type !== 'color');
}

function loadSavedViewId() {
  try {
    const id = localStorage.getItem(CAMERA_VIEW_STORAGE_KEY);
    return CAMERA_VIEWS.some((v) => v.id === id) ? id : null;
  } catch {
    return null;
  }
}

let labelEl = null;
let labelTimer = null;
/** Briefly shows the selected view's name. */
function flashViewLabel(label) {
  if (!labelEl) {
    labelEl = document.createElement('div');
    Object.assign(labelEl.style, {
      position: 'fixed',
      top: '12px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '4px 12px',
      background: 'rgba(0,0,0,0.55)',
      color: '#fff',
      font: '600 13px system-ui, sans-serif',
      borderRadius: '6px',
      zIndex: '20',
      pointerEvents: 'none',
      transition: 'opacity 0.3s',
      opacity: '0',
    });
    document.body.appendChild(labelEl);
  }
  labelEl.textContent = `Camera: ${label}`;
  labelEl.style.opacity = '1';
  clearTimeout(labelTimer);
  labelTimer = setTimeout(() => {
    labelEl.style.opacity = '0';
  }, 1200);
}

/**
 * Returns updateCamera(delta, { chassisMesh, podMesh, vehicle, vehicleId }),
 * with .cycleView/.setView/.getViewId/.getViews attached.
 */
export function createCameraFollow(camera) {
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

  let viewId = loadSavedViewId() ?? DEFAULT_CAMERA_VIEW_ID;
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
    };
  }

  /** Next frame snaps to the new view instead of lerping across the cut. */
  function resetSmoothing() {
    smoothedLookAtInit = false;
    smoothedYawInit = false;
    smoothedPitchInit = false;
    smoothedCloseScale = 1;
  }

  function setView(id) {
    const view = getCameraView(id, currentVehicleType);
    viewId = view.id;
    resetSmoothing();
    try {
      localStorage.setItem(CAMERA_VIEW_STORAGE_KEY, viewId);
    } catch {
      // Storage unavailable: works for this session only.
    }
    flashViewLabel(view.label);
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

  const updateCamera = function updateCamera(delta, { chassisMesh, podMesh, vehicle, vehicleId }) {
    if (!chassisMesh || !vehicle) return;
    currentVehicleType = getVehicle(vehicleId)?.vehicleType; // vehicle can change mid-drive
    const { view, offset, lookAtOffset, positionSpeed, lookAtSpeed } = activeParams();

    if (view.rigid) {
      // mountPoint 'pod': ride the chariot's pod; lookAtTarget 'chassis':
      // aim at the centre engine (the pod's own facing lags it).
      const mountMesh = view.mountPoint === 'pod' && podMesh ? podMesh : chassisMesh;
      const lookAtMesh = view.lookAtTarget === 'chassis' ? chassisMesh : null;
      updateRigid(view, mountMesh, lookAtMesh);
      return;
    }

    const cameraOffset = tmpOffsetVec.set(offset[0], offset[1], offset[2]);
    const cameraLookOffset = tmpLookOffsetVec.set(lookAtOffset[0], lookAtOffset[1], lookAtOffset[2]);

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
      CAMERA_CLOSE_SCALE_AT_MAX_SPEED,
      speedT
    );
    smoothedCloseScale += (targetCloseScale - smoothedCloseScale) * posFactor;

    // Lead the targets by velocity * settling time (1/speed) to cancel the
    // smoothing's steady-state lag.
    tmpLeadPos
      .set(vel.x, vel.y, vel.z)
      .multiplyScalar((CAMERA_POSITION_LEAD_FACTOR / positionSpeed));
    tmpLeadLook
      .set(vel.x, vel.y, vel.z)
      .multiplyScalar((CAMERA_POSITION_LEAD_FACTOR / lookAtSpeed));

    tmpVec
      .copy(cameraOffset)
      .multiplyScalar(smoothedCloseScale)
      .applyQuaternion(rotQuat)
      .add(carPos)
      .add(tmpLeadPos);
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
  };

  /** Floating-origin shift (camera.position itself is moved by the caller). */
  updateCamera.shiftOrigin = (dx, dz) => {
    smoothedLookAt.x -= dx;
    smoothedLookAt.z -= dz;
  };
  updateCamera.cycleView = cycleView;
  updateCamera.setView = setView;
  updateCamera.getViewId = () => viewId;
  updateCamera.getViews = () => CAMERA_VIEWS;

  return updateCamera;
}
