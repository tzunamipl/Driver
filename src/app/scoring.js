import * as CANNON from 'cannon-es';
import { GROUND_COLLISION_GROUP } from '../lib/terrain.js';
import {
  SCORE_PER_KM,
  SCORE_TELEPORT_M,
  SCORE_PER_AIR_SECOND,
  FLIGHT_MIN_CLEARANCE_M,
  GROUND_RAY_HEIGHT,
} from '../config.js';

// Awards the local driver's score from travel and airtime. Pedestrian hits
// are scored separately (whoever runs one over). Whole kilometres and whole
// seconds pay out; the leftover fraction carries to the next award. A reset
// or address recenter is a position jump, not distance, and the drop onto
// the new ground does not count as flight until the wheels touch once.

export function createScoring({ world, carManager, onJumpScore }) {
  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const rayResult = new CANNON.RaycastResult();

  let prevMesh = null;
  let prevX = 0;
  let prevZ = 0;
  let kmRemainder = 0;
  let airRemainder = 0;
  let hasLanded = false;
  let wasAirborne = false;
  let jumpAward = 0;

  function groundClearance(chassisBody) {
    const pos = chassisBody.position;
    rayFrom.set(pos.x, pos.y + GROUND_RAY_HEIGHT, pos.z);
    rayTo.set(pos.x, pos.y - GROUND_RAY_HEIGHT, pos.z);
    rayResult.reset();
    world.raycastClosest(rayFrom, rayTo, { collisionFilterMask: GROUND_COLLISION_GROUP }, rayResult);
    if (!rayResult.hasHit) return 0;
    return pos.y - rayResult.hitPointWorld.y;
  }

  function payout(remainder, unitPoints) {
    const whole = Math.floor(remainder);
    if (whole <= 0) return { remainder, points: 0 };
    const points = whole * unitPoints;
    carManager.addScore(points);
    return { remainder: remainder - whole, points };
  }

  // A jump's points are announced once, when the wheels are back on the
  // ground, so a two-second flight reads as one "+20" rather than a stream.
  function finishJump() {
    if (wasAirborne && jumpAward > 0) onJumpScore?.(jumpAward);
    wasAirborne = false;
    jumpAward = 0;
  }

  function update(dt, chassisMesh, vehicle) {
    const x = chassisMesh.position.x;
    const z = chassisMesh.position.z;
    if (chassisMesh !== prevMesh) {
      finishJump();
      prevMesh = chassisMesh;
      prevX = x;
      prevZ = z;
      hasLanded = false;
      return;
    }

    const dist = Math.hypot(x - prevX, z - prevZ);
    prevX = x;
    prevZ = z;
    // New spawn: the fall onto the road is not a jump, and the gap between
    // the old spot and the new one is not kilometres driven.
    if (dist >= SCORE_TELEPORT_M) {
      finishJump();
      hasLanded = false;
      return;
    }
    if (dist > 0) {
      kmRemainder = payout(kmRemainder + dist / 1000, SCORE_PER_KM).remainder;
    }

    const wheels = vehicle.wheelInfos;
    if (wheels.some((wheel) => wheel.isInContact)) hasLanded = true;
    if (!hasLanded || wheels.length === 0) return;

    const airborne =
      wheels.every((wheel) => !wheel.isInContact) &&
      groundClearance(vehicle.chassisBody) >= FLIGHT_MIN_CLEARANCE_M;
    if (!airborne) {
      finishJump();
      return;
    }
    wasAirborne = true;
    const paid = payout(airRemainder + dt, SCORE_PER_AIR_SECOND);
    airRemainder = paid.remainder;
    jumpAward += paid.points;
  }

  return { update };
}
