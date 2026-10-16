// Suspension thud: a dull knock when a wheel's suspension compresses fast
// (landings, kerbs, potholes), one per wheel per hit.

import { playThud } from './impact.js';

const MIN_CLOSING_SPEED = 0.8; // m/s; below = ordinary road bumps
const CLOSING_SPEED_FOR_MAX = 6;
const MIN_GAIN = 0.2;
const MAX_GAIN = 3.0;
const COOLDOWN_S = 0.15; // per wheel, so one hit doesn't retrigger while it settles

export function createSuspensionThud() {
  const cooldowns = [];
  // Rising edge only: a hit plays once, even if compression stays fast for a few frames.
  const armed = [];

  /** @param {object|null} vehicle - wheeledVehicle.js vehicle, or null. */
  function update(dt, vehicle) {
    const wheels = vehicle?.wheelInfos ?? [];
    let loudest = 0;
    for (let i = 0; i < wheels.length; i++) {
      cooldowns[i] = Math.max(0, (cooldowns[i] ?? 0) - dt);
      const speed = wheels[i].closingSpeed ?? 0;
      if (speed < MIN_CLOSING_SPEED) {
        armed[i] = true;
        continue;
      }
      if (armed[i] === false || cooldowns[i] > 0) continue;
      armed[i] = false;
      cooldowns[i] = COOLDOWN_S;
      loudest = Math.max(loudest, speed);
    }
    // Wheels hitting together (a flat landing) make one bigger thud, not a stack.
    if (loudest > 0) {
      const level = Math.min(1, (loudest - MIN_CLOSING_SPEED) / (CLOSING_SPEED_FOR_MAX - MIN_CLOSING_SPEED));
      playThud(level, {
        gain: MIN_GAIN + (MAX_GAIN - MIN_GAIN) * level,
        pitch: 0.31,
        crunch: 0.2,
        knock: 0.3, // muffled attack: rubber and springs, not metal
        attack: 0.015,
        length: 1.0,
      });
    }
  }

  return { update };
}
