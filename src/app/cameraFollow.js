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
} from '../config.js';

// Chase camera: follows the car's velocity direction (not just its facing
// direction) with yaw smoothing so suspension/wheel-contact jitter doesn't
// get amplified into visible high-speed camera shake, and freezes yaw
// while the car is flipped/tumbling instead of spinning wildly.

/**
 * Creates a stateful camera-follow updater bound to a given camera. All
 * smoothing state (previous yaw, smoothed look-at, etc.) lives in this
 * closure rather than module-level globals, so it can't leak across
 * unrelated camera instances (e.g. in tests).
 */
export function createCameraFollow(camera) {
  const cameraOffset = new THREE.Vector3(...CAMERA_OFFSET);
  const cameraLookOffset = new THREE.Vector3(...CAMERA_LOOKAT_OFFSET);
  const tmpVec = new THREE.Vector3();
  const tmpForward = new THREE.Vector3();
  const tmpCarUp = new THREE.Vector3();
  const tmpLeadPos = new THREE.Vector3();
  const tmpLeadLook = new THREE.Vector3();
  const yawQuat = new THREE.Quaternion();
  const upVec = new THREE.Vector3(0, 1, 0);
  const smoothedLookAt = new THREE.Vector3();
  let smoothedLookAtInit = false;
  let lastYaw = 0;
  let smoothedYaw = 0;
  let smoothedYawInit = false;
  let smoothedCloseScale = 1;

  return function updateCamera(delta, { chassisMesh, vehicle }) {
    if (!chassisMesh || !vehicle) return;
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

    // Frame-rate independent exponential smoothing, so panning speed stays
    // consistent regardless of delta time (e.g. during rapid crash motion).
    const posFactor = 1 - Math.exp(-CAMERA_POSITION_SPEED * delta);
    const lookFactor = 1 - Math.exp(-CAMERA_LOOKAT_SPEED * delta);

    // Pull the camera in closer as speed decreases, so slowing down/idling
    // feels more intimate while cruising at speed keeps the wider framing.
    // Based on actual car speed (not just horizontal velocity) so it still
    // reacts correctly e.g. mid-air after a big jump.
    const bodyVel = vehicle.chassisBody.velocity;
    const speed = bodyVel.length();
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
      .set(bodyVel.x, bodyVel.y, bodyVel.z)
      .multiplyScalar((CAMERA_POSITION_LEAD_FACTOR / CAMERA_POSITION_SPEED));
    tmpLeadLook
      .set(bodyVel.x, bodyVel.y, bodyVel.z)
      .multiplyScalar((CAMERA_POSITION_LEAD_FACTOR / CAMERA_LOOKAT_SPEED));

    tmpVec
      .copy(cameraOffset)
      .multiplyScalar(smoothedCloseScale)
      .applyQuaternion(yawQuat)
      .add(carPos)
      .add(tmpLeadPos);
    camera.position.lerp(tmpVec, posFactor);

    const lookAt = cameraLookOffset
      .clone()
      .multiplyScalar(smoothedCloseScale)
      .applyQuaternion(yawQuat)
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
}
