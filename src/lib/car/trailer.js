// Articulated trailer coupling: a ball joint at the fifth wheel (tractor
// hitch <-> trailer kingpin), plus spring-damper torques for what a ball joint
// leaves free: relative roll (a fifth wheel plate resists it) and articulation
// past the jackknife stop (tractor and trailer don't collide with each other).

import * as CANNON from 'cannon-es';
import { GRAVITY } from '../physicsConstants.js';

const DEFAULT_MAX_ARTICULATION = 1.4; // rad, ~80 degrees
const ROLL_FREQUENCY_HZ = 2;
const STOP_FREQUENCY_HZ = 2.5;
const DAMPING_RATIO = 0.7;
// Joint force cap as a multiple of the trailer's weight.
const HITCH_MAX_FORCE_G = 30;

const FORWARD = new CANNON.Vec3(0, 0, 1);
const UP = new CANNON.Vec3(0, 1, 0);

/** Places the trailer straight behind the tractor with its kingpin on the hitch. */
export function placeTrailer(tractorBody, trailerBody, hitchLocal, kingpinLocal, quaternion = tractorBody.quaternion) {
  const hitchWorld = tractorBody.pointToWorldFrame(hitchLocal, new CANNON.Vec3());
  const kingpinOffset = quaternion.vmult(kingpinLocal, new CANNON.Vec3());
  trailerBody.position.copy(hitchWorld.vsub(kingpinOffset));
  trailerBody.quaternion.copy(quaternion);
  trailerBody.velocity.copy(tractorBody.velocity);
  trailerBody.angularVelocity.set(0, 0, 0);
}

/** Spring constant + damping coefficient for a torsional spring of `inertia` ringing at `hz`. */
function torsionalSpring(inertia, hz) {
  const omega = 2 * Math.PI * hz;
  return { k: inertia * omega * omega, c: 2 * DAMPING_RATIO * inertia * omega };
}

/** Effective inertia of two bodies twisting against each other about a local axis. */
function reducedInertia(a, b, axis) {
  const ia = a.inertia[axis];
  const ib = b.inertia[axis];
  return (ia * ib) / (ia + ib);
}

export function createTrailerHitch(world, tractorBody, trailerBody, { hitchLocal, kingpinLocal, maxArticulation = DEFAULT_MAX_ARTICULATION }) {
  const constraint = new CANNON.PointToPointConstraint(
    tractorBody,
    hitchLocal,
    trailerBody,
    kingpinLocal,
    trailerBody.mass * GRAVITY * HITCH_MAX_FORCE_G
  );
  constraint.collideConnected = false;
  world.addConstraint(constraint);

  const roll = torsionalSpring(reducedInertia(tractorBody, trailerBody, 'z'), ROLL_FREQUENCY_HZ);
  const stop = torsionalSpring(reducedInertia(tractorBody, trailerBody, 'y'), STOP_FREQUENCY_HZ);

  const fT = new CANNON.Vec3();
  const uT = new CANNON.Vec3();
  const fA = new CANNON.Vec3();
  const uA = new CANNON.Vec3();
  const tmp = new CANNON.Vec3();
  const cross = new CANNON.Vec3();
  const relW = new CANNON.Vec3();
  const torque = new CANNON.Vec3();

  /** Signed angle from `from` to `v` (projected off `axis`) about `axis`. */
  function angleAbout(axis, from, v) {
    axis.scale(v.dot(axis), tmp);
    v.vsub(tmp, tmp);
    from.cross(tmp, cross);
    return Math.atan2(axis.dot(cross), from.dot(tmp));
  }

  function applyCouple(axis, magnitude) {
    axis.scale(magnitude, torque);
    trailerBody.torque.vadd(torque, trailerBody.torque);
    tractorBody.torque.vsub(torque, tractorBody.torque);
  }

  function preStep() {
    if (trailerBody.type !== CANNON.Body.DYNAMIC) return;
    trailerBody.vectorToWorldFrame(FORWARD, fT);
    trailerBody.vectorToWorldFrame(UP, uT);
    tractorBody.vectorToWorldFrame(FORWARD, fA);
    tractorBody.vectorToWorldFrame(UP, uA);
    tractorBody.angularVelocity.vsub(trailerBody.angularVelocity, relW);

    const rollAngle = angleAbout(fT, uT, uA);
    applyCouple(fT, roll.k * rollAngle + roll.c * relW.dot(fT));

    const yaw = angleAbout(uT, fT, fA);
    const excess = Math.abs(yaw) - maxArticulation;
    if (excess > 0) applyCouple(uT, Math.sign(yaw) * stop.k * excess + stop.c * relW.dot(uT));
  }
  world.addEventListener('preStep', preStep);

  function dispose() {
    world.removeConstraint(constraint);
    world.removeEventListener('preStep', preStep);
  }

  return { constraint, dispose };
}
