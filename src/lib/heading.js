import * as THREE from 'three';

// Shared heading-angle helper used by both the compass gauge and the
// terrain-stats HUD, so the two stay in sync and the direction math lives
// in exactly one place.

const _forward = new THREE.Vector3();

/**
 * Computes the car's current heading in degrees (0-360, 0 = north), by
 * projecting the chassis' local forward axis onto the world XZ plane.
 * World +z is south (see config.js DIRECTIONS), so north is -z; negate z
 * here to match that convention.
 */
export function computeHeadingDeg(chassisMesh) {
  _forward.set(0, 0, 1).applyQuaternion(chassisMesh.quaternion);
  const deg = THREE.MathUtils.radToDeg(Math.atan2(_forward.x, -_forward.z));
  return (deg + 360) % 360;
}

/** Snaps a heading (degrees) to one of 8 compass direction entries. */
export function headingDirection(headingDeg, directions) {
  const index = Math.round(headingDeg / 45) % 8;
  return directions[index];
}
