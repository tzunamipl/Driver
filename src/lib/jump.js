import * as CANNON from 'cannon-es';
import { isWheelGrounded } from './wheelContact.js';
import { JUMP_CHARGE_S, JUMP_MIN_SPEED, JUMP_MAX_SPEED } from '../config.js';

// Hold to charge, release to jump. A tap is a small hop; holding through
// JUMP_CHARGE_S reaches JUMP_MAX_SPEED. Only fires with the wheels on the
// ground, so a hold in the air does not become a second jump.

export function createJump({ world }) {
  const button = document.querySelector('#touch-controls button[data-code="KeyJ"]');
  let charge = 0;
  let wasHeld = false;

  function grounded(vehicle) {
    if (vehicle.numWheelsOnGround > 0) return true;
    return vehicle.wheelInfos.some((wheel) => isWheelGrounded(world, wheel));
  }

  function update(dt, held, vehicle) {
    const canJump = !!vehicle && vehicle.chassisBody.type === CANNON.Body.DYNAMIC && grounded(vehicle);
    if (held && canJump) charge = Math.min(1, charge + dt / JUMP_CHARGE_S);
    if (wasHeld && !held) {
      if (canJump && charge > 0) {
        const speed = JUMP_MIN_SPEED + (JUMP_MAX_SPEED - JUMP_MIN_SPEED) * charge;
        const velocity = vehicle.chassisBody.velocity;
        velocity.y = Math.max(0, velocity.y) + speed;
      }
      charge = 0;
    }
    if (!held) charge = 0;
    wasHeld = held;
    if (button) button.style.setProperty('--charge', held ? String(charge) : '0');
    return charge;
  }

  return { update };
}
