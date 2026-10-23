// Suspension thud: a dull knock when a wheel's suspension compresses fast and far
// (landings, kerbs, potholes), one per wheel per compression stroke.

import { playThud } from './impact.js';

const MIN_CLOSING_SPEED = 0.4; // m/s; below = ordinary road bumps
const MIN_TRAVEL = 0.05; // m compressed within one stroke; filters fast but tiny jitters
const CLOSING_SPEED_FOR_MAX = 9;
const MIN_GAIN = 0.03;
const MAX_GAIN = 4.0;
const COOLDOWN_S = 0.15; // per wheel, so one hit doesn't retrigger while it settles

export function createSuspensionThud() {
  const cooldowns = [];
  const lastLength = [];
  // Per-wheel stroke: starts once closing speed passes the threshold, ends when compression stops.
  const strokeStart = [];
  const strokePeak = [];
  const strokeFired = [];

  /** @param {object|null} vehicle - wheeledVehicle.js vehicle, or null. */
  function update(dt, vehicle) {
    const wheels = vehicle?.wheelInfos ?? [];
    let loudest = 0;
    for (let i = 0; i < wheels.length; i++) {
      const wheel = wheels[i];
      cooldowns[i] = Math.max(0, (cooldowns[i] ?? 0) - dt);
      const length = wheel.suspensionLength;
      const prevLength = lastLength[i] ?? length;
      lastLength[i] = length;
      // From the length itself, not wheel.closingSpeed: that is chassis-vs-ground velocity
      // and misses ground that moves under the ray (surface imperfection steps).
      const speed = dt > 0 ? (prevLength - length) / dt : 0;

      if (!wheel.isInContact || speed <= 0) {
        strokeStart[i] = null;
        continue;
      }
      if (strokeStart[i] == null) {
        if (speed < MIN_CLOSING_SPEED) continue;
        // Previous frame's length, so a landing counts the drop from full extension.
        strokeStart[i] = prevLength;
        strokePeak[i] = 0;
        strokeFired[i] = false;
      }
      strokePeak[i] = Math.max(strokePeak[i], speed);
      if (strokeFired[i] || cooldowns[i] > 0) continue;
      if (strokeStart[i] - length < MIN_TRAVEL) continue;
      strokeFired[i] = true;
      cooldowns[i] = COOLDOWN_S;
      loudest = Math.max(loudest, strokePeak[i]);
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
