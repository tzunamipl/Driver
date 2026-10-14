// Engine-formation physics for the pod racer: live heading derived from the
// real engine positions, engine-to-engine power coupling, and the pod tether.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

const MAX_BANK_ANGLE = 0.5; // rad, clamp on visible roll from engine height difference

// Spring+damper between every engine pair (braces a rigid triangle). The
// cubic term is negligible near rest but stiffens hard when pulled apart.
const COUPLING_STIFFNESS = 50000; // N/m
const COUPLING_STIFFNESS_PROGRESSIVE = 4000000; // N/m^3
const COUPLING_DAMPING = 6000000; // N/(m/s)
const COUPLING_MAX_FORCE = 84000;

/**
 * Heading derived each step from the outermost engines: right = left->right
 * engine (horizontal), forward = right rotated -90deg about up, bank from
 * their height difference. No state of its own beyond a fallback forward.
 * Exposes live `forward`/`right` vectors.
 */
export function createFormationHeading(engineBodies, engineOffsets, startQuaternion) {
  // Fixed from layout so a wobble can't swap which engine is outermost.
  const sorted = engineOffsets.map((_, i) => i).sort((a, b) => engineOffsets[a].x - engineOffsets[b].x);
  const leftBody = engineBodies[sorted[0]];
  const rightBody = engineBodies[sorted[sorted.length - 1]];

  const right = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const up = new THREE.Vector3();
  const lastGoodForward = new THREE.Vector3(0, 0, 1).applyQuaternion(
    new THREE.Quaternion(startQuaternion.x, startQuaternion.y, startQuaternion.z, startQuaternion.w)
  );
  const lookMatrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  let horizDist = 0;

  /** Recomputes forward/right/bank; returns the formation quaternion. */
  function update() {
    const l = leftBody.position;
    const r = rightBody.position;
    right.set(r.x - l.x, 0, r.z - l.z);
    horizDist = right.length();
    if (horizDist < 1e-4) {
      forward.copy(lastGoodForward);
    } else {
      right.multiplyScalar(1 / horizDist);
      forward.set(-right.z, 0, right.x).normalize();
      lastGoodForward.copy(forward);
    }
    const bank = THREE.MathUtils.clamp(Math.atan2(r.y - l.y, Math.max(horizDist, 1e-4)), -MAX_BANK_ANGLE, MAX_BANK_ANGLE);
    up.set(0, 1, 0).applyAxisAngle(forward, bank);
    lookMatrix.lookAt(forward, new THREE.Vector3(), up);
    quat.setFromRotationMatrix(lookMatrix);
    return quat;
  }

  /** Live yaw rate (rad/s) from the outer engines' relative velocity; call after update(). */
  function yawRate() {
    if (horizDist < 1e-4) return 0;
    const lv = leftBody.velocity;
    const rv = rightBody.velocity;
    return ((rv.x - lv.x) * forward.x + (rv.z - lv.z) * forward.z) / horizDist;
  }

  return { update, yawRate, forward, right };
}

/** Returns apply(): spring+damper pulling every engine pair to its layout separation. */
export function createPowerCoupling(engineBodies, engineOffsets) {
  const pairs = [];
  for (let i = 0; i < engineOffsets.length; i++) {
    for (let j = i + 1; j < engineOffsets.length; j++) {
      const a = engineOffsets[i];
      const b = engineOffsets[j];
      pairs.push({ i, j, restLength: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) });
    }
  }
  const delta = new CANNON.Vec3();
  const relVel = new CANNON.Vec3();
  const force = new CANNON.Vec3();

  return function apply() {
    for (const pair of pairs) {
      const a = engineBodies[pair.i];
      const b = engineBodies[pair.j];
      delta.copy(b.position).vsub(a.position, delta);
      const dist = delta.length();
      if (dist < 1e-6) continue;
      delta.scale(1 / dist, delta); // a -> b
      relVel.copy(b.velocity).vsub(a.velocity, relVel);
      const stretch = dist - pair.restLength;
      const forceMag = THREE.MathUtils.clamp(
        stretch * COUPLING_STIFFNESS + stretch ** 3 * COUPLING_STIFFNESS_PROGRESSIVE + relVel.dot(delta) * COUPLING_DAMPING,
        -COUPLING_MAX_FORCE,
        COUPLING_MAX_FORCE
      );
      // Positive = stretched: pull the pair together.
      force.copy(delta).scale(forceMag, force);
      b.applyForce(force.scale(-1, force));
      a.applyForce(force.scale(-1, force));
    }
  };
}

/** Writes the engines' mean position (and optionally velocity) into the outputs. */
export function engineCentroid(engineBodies, outPos, outVel) {
  outPos.set(0, 0, 0);
  if (outVel) outVel.set(0, 0, 0);
  for (const body of engineBodies) {
    outPos.vadd(body.position, outPos);
    if (outVel) outVel.vadd(body.velocity, outVel);
  }
  outPos.scale(1 / engineBodies.length, outPos);
  if (outVel) outVel.scale(1 / engineBodies.length, outVel);
}

/**
 * Returns apply(): one-sided "steel cable" from the engine centroid to the
 * pod. Slack below maxLength; once taut, a mass-weighted position projection
 * plus an inelastic impulse cancel further separation (cannon-es has no
 * one-sided distance constraint).
 */
export function createTether(engineBodies, podBody, maxLength) {
  const count = engineBodies.length;
  const centroid = new CANNON.Vec3();
  const centroidVel = new CANNON.Vec3();
  const dir = new CANNON.Vec3();
  const rel = new CANNON.Vec3();
  const impulse = new CANNON.Vec3();

  return function apply() {
    engineCentroid(engineBodies, centroid, centroidVel);
    dir.copy(podBody.position).vsub(centroid, dir);
    const dist = dir.length();
    if (dist < 1e-6 || dist <= maxLength) return; // slack
    dir.scale(1 / dist, dir); // centroid -> pod

    const enginesInvMass = engineBodies[0].invMass * count;
    const totalInvMass = enginesInvMass + podBody.invMass;
    if (totalInvMass <= 0) return;

    // 1. Project back onto the max-length sphere (lighter side moves more).
    const penetration = dist - maxLength;
    const podFrac = podBody.invMass / totalInvMass;
    const perEngineFrac = enginesInvMass / totalInvMass / count;
    podBody.position.x -= dir.x * penetration * podFrac;
    podBody.position.y -= dir.y * penetration * podFrac;
    podBody.position.z -= dir.z * penetration * podFrac;
    for (const body of engineBodies) {
      body.position.x += dir.x * penetration * perEngineFrac;
      body.position.y += dir.y * penetration * perEngineFrac;
      body.position.z += dir.z * penetration * perEngineFrac;
    }

    // 2. Cancel the separating relative velocity (no bounce).
    rel.copy(podBody.velocity).vsub(centroidVel, rel);
    const sepSpeed = rel.dot(dir);
    if (sepSpeed <= 0) return;
    const impulseMag = sepSpeed / totalInvMass;
    impulse.copy(dir).scale(-impulseMag, impulse);
    podBody.applyImpulse(impulse);
    impulse.copy(dir).scale(impulseMag / count, impulse);
    for (const body of engineBodies) body.applyImpulse(impulse);
  };
}
