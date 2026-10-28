// Dust on loose off-road surfaces (SURFACE_DUST: amount + colours), from two triggers:
//  - slide: a puff per grounded sliding wheel, thrown by its spin-slip;
//  - speed: above DUST_SPEED_KMH / amount, one bigger puff under the chassis centre,
//    emitted more often / larger / more opaque as speed rises.
// `amount` scales emit rate, start speed and (by its square root) opacity and size;
// the speed puff uses the dustiest surface under a grounded wheel.

import { isWheelGrounded } from './wheelContact.js';
import { createPuffPool, wheelSpinLaunch, clamp } from './particles/puffPool.js';

const POOL_SIZE = 192; // sand emits at up to 2.5x the open-ground rate
const PARTICLE_LIFETIME_S = 0.9;
const START_SCALE = 0.25;
const RISE_SPEED = [0.2, 0.7];
const OUTWARD_SPEED = [0.5, 1.8];
const DRAG = 0.99; // velocity multiplier per second
const VELOCITY_INHERIT_FRACTION = 0.1;

// Surfaces that raise dust; others (road, forest, water, ...) don't.
const SURFACE_DUST = {
  normal: { amount: 1, colors: [0x5c3f23, 0x8a5a2e] },
  snow: { amount: 1.2, colors: [0xf4f6f9, 0xe2e8ee] },
  sand: { amount: 2.5, colors: [0xd8c08a, 0xc2a66b] },
  unpaved: { amount: 0.7, colors: [0xa59d90, 0x8f877a] },
  scrub: { amount: 0.6, colors: [0x7a5f3c, 0x9a7f55] },
  rock: { amount: 0.6, colors: [0x8d8a84, 0xa8a49c] },
};

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
    colors: SURFACE_DUST.normal.colors,
  });
  let slideTimers = []; // per-wheel, resized when wheel count changes
  let speedTimer = 0;
  let enabled = true;

  /**
   * @param {number} dt - frame delta in seconds.
   * @param {object|null} vehicle - wheeledVehicle.js vehicle, or null before a car exists.
   * @param {import('cannon-es').World|null} world
   */
  function update(dt, vehicle, world) {
    puffs.update(dt);

    if (!enabled || !vehicle || !world) return;
    if (slideTimers.length !== vehicle.wheelInfos.length) {
      slideTimers = vehicle.wheelInfos.map(() => 0);
    }

    const chassisVelocity = vehicle.chassisBody.velocity;
    const speed = chassisVelocity.length();

    speedTimer -= dt;
    let speedDust = null; // dustiest surface under a grounded wheel
    // Average ground height under grounded wheels, to anchor the speed puff.
    let groundYSum = 0;
    let groundYCount = 0;

    vehicle.wheelInfos.forEach((wheel, i) => {
      slideTimers[i] -= dt;
      const dust = SURFACE_DUST[wheel.surface];
      if (!dust) return;
      if (!isWheelGrounded(world, wheel)) return;
      if (!speedDust || dust.amount > speedDust.amount) speedDust = dust;
      const boost = Math.sqrt(dust.amount);
      const pos = wheel.worldTransform.position;
      const groundY = pos.y - wheel.radius * 0.9;
      groundYSum += groundY;
      groundYCount++;

      if (wheel.sliding && slideTimers[i] <= 0) {
        const extra = wheelSpinLaunch(wheel, SPIN_LAUNCH_FRACTION, SPIN_LAUNCH_SPEED_MAX, spinVelocityScratch);
        for (let n = 0; n < SLIDE_PARTICLES_PER_EMIT; n++) {
          puffs.spawn(pos.x, groundY, pos.z, {
            opacity: Math.min(1, SLIDE_BASE_OPACITY * boost),
            endScale: SLIDE_END_SCALE * boost,
            out: OUTWARD_SPEED,
            rise: RISE_SPEED,
            inherit: chassisVelocity,
            inheritFraction: VELOCITY_INHERIT_FRACTION,
            extra,
            colors: dust.colors,
          });
        }
        slideTimers[i] = SLIDE_EMIT_INTERVAL_S / dust.amount;
      }
    });

    const startSpeed = speedDust ? DUST_SPEED_MS / speedDust.amount : Infinity;
    if (groundYCount > 0 && speed >= startSpeed && speedTimer <= 0) {
      const speedFrac = clamp((speed - startSpeed) / (SPEED_FOR_MIN_INTERVAL_MS - startSpeed), 0, 1);
      const boost = Math.sqrt(speedDust.amount);
      const chassisPos = vehicle.chassisBody.position;
      puffs.spawn(chassisPos.x, groundYSum / groundYCount, chassisPos.z, {
        opacity: Math.min(1, (SPEED_OPACITY_MIN + (SPEED_OPACITY_MAX - SPEED_OPACITY_MIN) * speedFrac) * boost),
        endScale: (SPEED_END_SCALE_MIN + (SPEED_END_SCALE_MAX - SPEED_END_SCALE_MIN) * speedFrac) * boost,
        out: OUTWARD_SPEED,
        rise: RISE_SPEED,
        inherit: chassisVelocity,
        inheritFraction: VELOCITY_INHERIT_FRACTION,
        colors: speedDust.colors,
      });
      speedTimer = (SPEED_EMIT_INTERVAL_MAX_S - (SPEED_EMIT_INTERVAL_MAX_S - SPEED_EMIT_INTERVAL_MIN_S) * speedFrac) / speedDust.amount;
    }
  }

  /** Off: no new dust (puffs in the air finish). */
  function setEnabled(on) {
    enabled = on;
  }

  return { update, setEnabled };
}
