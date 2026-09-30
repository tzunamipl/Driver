import * as CANNON from 'cannon-es';
import { GROUND_COLLISION_GROUP } from '../lib/terrain.js';
import { isWheelGrounded } from '../lib/wheelContact.js';
import {
  SCORE_PER_KM,
  SCORE_TELEPORT_M,
  SCORE_PER_AIR_SECOND,
  FLIGHT_MIN_CLEARANCE_M,
  AIRTIME_MIN_UPRIGHT_DOT,
  GROUND_RAY_HEIGHT,
} from '../config.js';

// Awards the local driver's score from travel and airtime. Pedestrian hits
// are scored separately (whoever runs one over). Kilometres pay out whole,
// the leftover fraction carrying to the next award. Airtime accrues
// fractional points every frame (so the live HUD ticks up smoothly) but is
// only credited to the score once, as a whole number, when the jump ends.
// Airtime also requires the chassis to stay roughly right-side-up - a
// barrel-rolled/upside-down flip stops the count. A reset or address
// recenter is a position jump, not distance, and the drop onto the new
// ground does not count as flight until the wheels touch once.

export function createScoring({
  world,
  carManager,
  onJumpScore,
  onAirtimeUpdate,
  onAirtimeEnd,
  scorePerAirSecond = SCORE_PER_AIR_SECOND,
}) {
  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const rayResult = new CANNON.RaycastResult();
  const localUp = new CANNON.Vec3(0, 1, 0);
  const worldUp = new CANNON.Vec3();

  let prevMesh = null;
  let prevX = 0;
  let prevZ = 0;
  let kmRemainder = 0;
  let hasLanded = false;
  let wasAirborne = false;
  let jumpPointsRaw = 0;

  function groundClearance(chassisBody) {
    const pos = chassisBody.position;
    rayFrom.set(pos.x, pos.y + GROUND_RAY_HEIGHT, pos.z);
    rayTo.set(pos.x, pos.y - GROUND_RAY_HEIGHT, pos.z);
    rayResult.reset();
    world.raycastClosest(rayFrom, rayTo, { collisionFilterMask: GROUND_COLLISION_GROUP }, rayResult);
    if (!rayResult.hasHit) return 0;
    return pos.y - rayResult.hitPointWorld.y;
  }

  // A barrel-rolled/upside-down flip doesn't pay out: only a chassis still
  // roughly right-side-up (within AIRTIME_MIN_UPRIGHT_DOT) counts as valid
  // airtime.
  function isUpright(chassisBody) {
    chassisBody.quaternion.vmult(localUp, worldUp);
    return worldUp.y >= AIRTIME_MIN_UPRIGHT_DOT;
  }

  function payout(remainder, unitPoints) {
    const whole = Math.floor(remainder);
    if (whole <= 0) return { remainder, points: 0 };
    const points = whole * unitPoints;
    carManager.addScore(points);
    return { remainder: remainder - whole, points };
  }

  // A jump's points accrue by the fraction of a second every frame (so the
  // live HUD counts up smoothly), but are only credited to the score once,
  // as a whole number, when the wheels are back on the ground - a
  // two-second flight reads as one "+20" rather than a stream.
  function finishJump() {
    if (wasAirborne) {
      const whole = Math.floor(jumpPointsRaw);
      if (whole > 0) {
        carManager.addScore(whole);
        onJumpScore?.(whole);
      }
      onAirtimeEnd?.();
    }
    wasAirborne = false;
    jumpPointsRaw = 0;
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
    if (wheels.some((wheel) => isWheelGrounded(world, wheel))) hasLanded = true;
    if (!hasLanded || wheels.length === 0) return;

    const airborne =
      wheels.every((wheel) => !isWheelGrounded(world, wheel)) &&
      groundClearance(vehicle.chassisBody) >= FLIGHT_MIN_CLEARANCE_M &&
      isUpright(vehicle.chassisBody);
    if (!airborne) {
      finishJump();
      return;
    }
    wasAirborne = true;
    jumpPointsRaw += scorePerAirSecond * dt;
    onAirtimeUpdate?.(Math.floor(jumpPointsRaw));
  }

  return { update, isLanded: () => hasLanded };
}

