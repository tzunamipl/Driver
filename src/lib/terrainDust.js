// Brown dirt dust on 'normal' (open terrain) surfaces, from two triggers:
//  - slide: a puff per grounded sliding wheel, thrown by its spin-slip;
//  - speed: above DUST_SPEED_KMH, one bigger puff under the chassis centre,
//    emitted more often / larger / more opaque as speed rises.

import { isWheelGrounded } from './wheelContact.js';
import { createPuffPool, wheelSpinLaunch, clamp } from './particles/puffPool.js';

const POOL_SIZE = 96;
const PARTICLE_LIFETIME_S = 0.9;
const START_SCALE = 0.25;
const RISE_SPEED = [0.2, 0.7];
const OUTWARD_SPEED = [0.5, 1.8];
const DRAG = 0.99; // velocity multiplier per second
const VELOCITY_INHERIT_FRACTION = 0.1;
const COLORS = [0x5c3f23, 0x8a5a2e];

const SLIDE_PARTICLES_PER_EMIT = 1;
const SLIDE_END_SCALE = 1.1;
const SLIDE_EMIT_INTERVAL_S = 0.08;
const SLIDE_BASE_OPACITY = 0.5;
const SPIN_LAUNCH_FRACTION = 0.95; // share of wheel spin-slip speed added to launch velocity
const SPIN_LAUNCH_SPEED_MAX = 15;

const DUST_SPEED_KMH = 50;
const DUST_SPEED_MS = DUST_SPEED_KMH / 3.6;
const SPEED_FOR_MIN_INTERVAL_MS = 150 / 3.6; // speed at which the speed trigger maxes out
const SPEED_EMIT_INTERVAL_MAX_S = 0.5;
const SPEED_EMIT_INTERVAL_MIN_S = 0.12;
const SPEED_OPACITY_MIN = 0.2;
const SPEED_OPACITY_MAX = 0.8;
const SPEED_END_SCALE_MIN = 2.1;
const SPEED_END_SCALE_MAX = 3.6;

const spinVelocityScratch = { x: 0, z: 0 };

/** Creates the terrain-dust effect. Call update() once per rendered frame. */
export function createTerrainDust(scene) {
  const puffs = createPuffPool(scene, {
    size: POOL_SIZE,
    lifetime: PARTICLE_LIFETIME_S,
    startScale: START_SCALE,
    drag: DRAG,
    colors: COLORS,
  });
  let slideTimers = []; // per-wheel, resized when wheel count changes
  let speedTimer = 0;

  /**
   * @param {number} dt - frame delta in seconds.
   * @param {object|null} vehicle - wheeledVehicle.js vehicle, or null before a car exists.
   * @param {import('cannon-es').World|null} world
   */
  function update(dt, vehicle, world) {
    puffs.update(dt);

    if (!vehicle || !world) return;
    if (slideTimers.length !== vehicle.wheelInfos.length) {
      slideTimers = vehicle.wheelInfos.map(() => 0);
    }

    const chassisVelocity = vehicle.chassisBody.velocity;
    const speed = chassisVelocity.length();
    const speedFrac = clamp((speed - DUST_SPEED_MS) / (SPEED_FOR_MIN_INTERVAL_MS - DUST_SPEED_MS), 0, 1);

    speedTimer -= dt;
    // Average ground height under grounded wheels, to anchor the speed puff.
    let groundYSum = 0;
    let groundYCount = 0;

    vehicle.wheelInfos.forEach((wheel, i) => {
      slideTimers[i] -= dt;
      if (wheel.surface !== 'normal') return;
      if (!isWheelGrounded(world, wheel)) return;
      const pos = wheel.worldTransform.position;
      const groundY = pos.y - wheel.radius * 0.9;
      groundYSum += groundY;
      groundYCount++;

      if (wheel.sliding && slideTimers[i] <= 0) {
        const extra = wheelSpinLaunch(wheel, SPIN_LAUNCH_FRACTION, SPIN_LAUNCH_SPEED_MAX, spinVelocityScratch);
        for (let n = 0; n < SLIDE_PARTICLES_PER_EMIT; n++) {
          puffs.spawn(pos.x, groundY, pos.z, {
            opacity: SLIDE_BASE_OPACITY,
            endScale: SLIDE_END_SCALE,
            out: OUTWARD_SPEED,
            rise: RISE_SPEED,
            inherit: chassisVelocity,
            inheritFraction: VELOCITY_INHERIT_FRACTION,
            extra,
          });
        }
        slideTimers[i] = SLIDE_EMIT_INTERVAL_S;
      }
    });

    if (groundYCount > 0 && speed >= DUST_SPEED_MS && speedTimer <= 0) {
      const chassisPos = vehicle.chassisBody.position;
      puffs.spawn(chassisPos.x, groundYSum / groundYCount, chassisPos.z, {
        opacity: SPEED_OPACITY_MIN + (SPEED_OPACITY_MAX - SPEED_OPACITY_MIN) * speedFrac,
        endScale: SPEED_END_SCALE_MIN + (SPEED_END_SCALE_MAX - SPEED_END_SCALE_MIN) * speedFrac,
        out: OUTWARD_SPEED,
        rise: RISE_SPEED,
        inherit: chassisVelocity,
        inheritFraction: VELOCITY_INHERIT_FRACTION,
      });
      speedTimer = SPEED_EMIT_INTERVAL_MAX_S - (SPEED_EMIT_INTERVAL_MAX_S - SPEED_EMIT_INTERVAL_MIN_S) * speedFrac;
    }
  }

  return { update };
}
