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

// Chase camera: follows the car's velocity direction (not just its facing
// direction) with yaw smoothing so suspension/wheel-contact jitter doesn't
// get amplified into visible high-speed camera shake, and freezes yaw
// while the car is flipped/tumbling instead of spinning wildly. A small,
// heavily smoothed pitch tilt is also applied based on the car's vertical
// velocity, so a steep climb or a long fall reads as a deliberate, subtle
// up/down look rather than the camera staying rigidly level.
//
// Multiple selectable *views* (chase/close/cinematic/hood - see
// app/cameraViews/) share this one updater: every view supplies only the
// handful of fields that make it distinct (offset, look-at offset, pan
// speed...), falling back to the CAMERA_* constants above as the shared
// baseline every view doesn't bother overriding - see `activeParams()`
// below. The "C" key (wired up in here, same self-contained toggle
// pattern as hud/debugVisuals.js's "M") cycles through
// app/cameraViews/'s registry.

function isTypingInField() {
  const el = document.activeElement;
  if (!el) return false;
  return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'range' && el.type !== 'color');
}

/** Reads a saved view id back out of localStorage, if any/valid. */
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
/** Briefly flashes the newly-picked view's name on screen, same
 * transient-notice idea as hud/notice.js but kept self-contained here
 * rather than threading a HUD dependency through createCameraFollow's
 * signature just for this one thing. */
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
 * Creates a stateful camera-follow updater bound to a given camera. All
 * smoothing state (previous yaw, smoothed look-at, etc.) lives in this
 * closure rather than module-level globals, so it can't leak across
 * unrelated camera instances (e.g. in tests).
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
  // Updated every frame from the vehicleId the caller passes in (see
  // updateCamera below), so cycleView()/setView() - both only ever
  // triggered from a keypress between frames - can restrict/fall back
  // views by the vehicle actually being driven right now (e.g. hiding
  // the hover-only pod cam - see cameraViews/pod.js - while driving a
  // wheeled car). Starts at `null` - the "not resolved yet" sentinel
  // cameraViews/index.js's viewMatchesVehicle() treats as "matches
  // anything" - until the first frame with a vehicle runs; after that
  // it's whatever that vehicle's own descriptor.vehicleType is (commonly
  // plain `undefined` for wheeled cars, which is a real, resolved
  // "doesn't match any restricted view" answer, not the same as `null`).
  let currentVehicleType = null;

  /** Merges the active view's descriptor over the shared CAMERA_*
   * baseline - the same `view.field ?? DEFAULT` pattern lib/car.js uses
   * to merge a vehicle descriptor over its own shared defaults. */
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

  function resetSmoothing() {
    // Dropping the init flags makes the next frame snap straight to the
    // new view's target instead of smoothly (and misleadingly) lerping
    // from the old view's camera position/angle across a hard cut.
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
      // Storage unavailable (private browsing, quota, etc.) - the view
      // picker still works for this session, it just won't persist.
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

  function updateRigid(view, mountMesh, lookAtMesh) {
    // Dashboard/hood cam: no chase-camera smoothing, velocity-direction
    // framing, or close-up distance scaling at all - the camera is just
    // parented directly to the mount transform every frame, same as a
    // real mounted camera would be. `mountMesh` is normally chassisMesh,
    // but views with `mountPoint: 'pod'` (see cameraViews/pod.js) get the
    // chariot's actual pod mesh instead - see updateCamera below.
    tmpVec.set(...(view.offset ?? [0, 1.3, 1.6])).applyQuaternion(mountMesh.quaternion).add(mountMesh.position);
    camera.position.copy(tmpVec);
    // Normally the look-at target is just another offset local to the
    // same mount (straight "ahead" from wherever it's facing). But
    // `lookAtMesh` (see updateCamera below) lets a view aim at a
    // *different* transform instead - e.g. the pod cam rides on the pod
    // but targets the centre engine mesh directly, so it actually tracks
    // the engines rather than wherever the pod itself happens to be
    // facing (its cosmetic facing lags/leads the engines on its own
    // tether-driven timing, so "forward from the pod" isn't reliably
    // "at the engines").
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
    // Resolved fresh each frame (cheap Map lookup, see
    // lib/vehicles/index.js's getVehicle) rather than cached once, since
    // the local vehicle can be swapped out mid-drive (debug picker/
    // lobby respawn) without this module being recreated.
    currentVehicleType = getVehicle(vehicleId)?.vehicleType;
    const { view, offset, lookAtOffset, positionSpeed, lookAtSpeed } = activeParams();

    if (view.rigid) {
      // Mount on the pod's own real, independently-tethered mesh - not
      // chassisMesh, which on a chariot is really the centre engine's
      // mesh (see lib/chariot.js) - so the camera inherits the pod's
      // actual swinging/lagging motion instead of the engine's. Falls
      // back to chassisMesh if podMesh somehow isn't available yet
      // (e.g. mid-respawn) rather than erroring.
      const mountMesh = view.mountPoint === 'pod' && podMesh ? podMesh : chassisMesh;
      // `lookAtTarget: 'chassis'` (see cameraViews/pod.js) makes the view
      // aim at the centre engine mesh instead of wherever the mount
      // itself is facing - see updateRigid()'s own comment above.
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
      // Point the camera where the car is actually moving (its velocity
      // direction) rather than where it's heading (its forward axis), so
      // e.g. sliding/drifting sideways or reversing looks correct. Only
      // the horizontal (XZ) component is used - pitch/roll from bumps or
      // rolling must never tilt the camera off the horizontal plane
      // (no-roll rule).
      const vel = vehicle.chassisBody.velocity;
      tmpForward.set(vel.x, 0, vel.z);
      if (tmpForward.lengthSq() < CAMERA_MIN_SPEED_FOR_VELOCITY_YAW * CAMERA_MIN_SPEED_FOR_VELOCITY_YAW) {
        // Too slow for velocity direction to be meaningful - use the
        // car's facing direction instead so the camera doesn't spin/
        // jitter at near-zero speed.
        tmpForward.set(0, 0, 1).applyQuaternion(carQuat);
        tmpForward.y = 0;
      }
      if (tmpForward.lengthSq() < 1e-8) tmpForward.set(0, 0, 1);
      tmpForward.normalize();
      yaw = Math.atan2(tmpForward.x, tmpForward.z);
      lastYaw = yaw;
    }

    // Smooth the yaw angle itself (shortest-path, wrap-safe) instead of
    // using the raw per-frame value directly - this is what actually
    // decouples the camera from small heading vibrations instead of just
    // smoothing the already-noisy rotated offset.
    if (!smoothedYawInit) {
      smoothedYaw = yaw;
      smoothedYawInit = true;
    } else {
      const yawDiff = Math.atan2(Math.sin(yaw - smoothedYaw), Math.cos(yaw - smoothedYaw));
      const yawFactor = 1 - Math.exp(-CAMERA_YAW_SPEED * delta);
      smoothedYaw += yawDiff * yawFactor;
    }
    yawQuat.setFromAxisAngle(upVec, smoothedYaw);

    // Tilt the camera up/down to follow steep climbs/falls: the velocity's
    // angle above/below horizontal (vertical speed vs horizontal speed)
    // gives the slope the car is actually traveling along, clamped to a
    // subtle max and zeroed out while too slow (same reasoning as the yaw
    // fallback above) so it never fights the no-roll rule's goal of
    // filtering out unintentional bump/roll jitter - only sustained
    // vertical motion moves this.
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
    // Pitch is applied around the already-yawed right axis (not world X),
    // so it tilts relative to the direction the camera is actually facing
    // regardless of heading.
    pitchQuat.setFromAxisAngle(rightVec, smoothedPitch);
    rotQuat.copy(yawQuat).multiply(pitchQuat);

    // Frame-rate independent exponential smoothing, so panning speed stays
    // consistent regardless of delta time (e.g. during rapid crash motion).
    // positionSpeed/lookAtSpeed are the active view's own pan speeds
    // (falling back to the shared CAMERA_POSITION_SPEED/CAMERA_LOOKAT_SPEED
    // defaults - see activeParams() above), so e.g. the cinematic view's
    // lazier pan doesn't require touching this shared updater at all.
    const posFactor = 1 - Math.exp(-positionSpeed * delta);
    const lookFactor = 1 - Math.exp(-lookAtSpeed * delta);

    // Pull the camera in closer as speed decreases, so slowing down/idling
    // feels more intimate while cruising at speed keeps the wider framing.
    // Based on actual car speed (not just horizontal velocity) so it still
    // reacts correctly e.g. mid-air after a big jump.
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

    // Exponential smoothing settles toward its target with time constant
    // 1/CAMERA_*_SPEED, so a constantly moving car steadily trails behind
    // by (velocity * time constant). Push the smoothing target ahead by
    // that same amount (scaled by CAMERA_POSITION_LEAD_FACTOR) so the
    // lag cancels out at any speed instead of only being tolerable at low
    // speeds - this is what keeps the camera from falling far behind at
    // extreme speeds while leaving the jitter-filtering smoothing itself
    // untouched.
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

  // Attached to the returned function itself (functions are objects) so
  // every existing `cameraFollow(delta, {...})` call site in
  // app/mainLoop.js keeps working unchanged, while callers that want view
  // switching (e.g. a future HUD button) can still reach
  // cameraFollow.cycleView()/.setView()/.getViewId().
  updateCamera.cycleView = cycleView;
  updateCamera.setView = setView;
  updateCamera.getViewId = () => viewId;
  updateCamera.getViews = () => CAMERA_VIEWS;

  return updateCamera;
}
