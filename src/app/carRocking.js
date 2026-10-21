// Rally mode's R key: no reset, the car is rocked like spectators pushing it. Each press
// kicks the roll the way the car is already swinging (or towards upright from rest), so
// presses in rhythm with the swing build it up until the car tips back onto its wheels.

import * as CANNON from 'cannon-es';

const ROLL_KICK = 2.4; // rad/s added per press
const LIFT_KICK = 1.2; // m/s up, the pushers lifting the low side
const MIN_INTERVAL_S = 0.18;
const MAX_SPEED = 4; // m/s: no pushing a moving car
const SWING_EPS = 0.3; // rad/s: below this, the car counts as at rest

const forward = new CANNON.Vec3();
const up = new CANNON.Vec3();

export function createCarRocking() {
  let lastPush = -Infinity;

  return {
    /** One push on the vehicle's chassis; `now` in seconds. */
    rock(vehicle, now) {
      const body = vehicle?.chassisBody;
      if (!body || now - lastPush < MIN_INTERVAL_S || body.velocity.length() > MAX_SPEED) return;
      lastPush = now;
      body.wakeUp();
      body.quaternion.vmult(new CANNON.Vec3(0, 0, 1), forward);
      body.quaternion.vmult(new CANNON.Vec3(0, 1, 0), up);
      const swing = body.angularVelocity.dot(forward);
      // At rest: towards upright, i.e. turning `up` towards world up about the roll axis.
      const towardsUpright = Math.sign(up.cross(new CANNON.Vec3(0, 1, 0)).dot(forward)) || 1;
      const dir = Math.abs(swing) > SWING_EPS ? Math.sign(swing) : towardsUpright;
      body.angularVelocity.vadd(forward.scale(ROLL_KICK * dir), body.angularVelocity);
      body.velocity.y += LIFT_KICK;
    },
  };
}
