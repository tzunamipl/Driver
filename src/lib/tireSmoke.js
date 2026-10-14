// Tyre smoke + screech: grey puffs from every grounded wheel that is sliding
// on a 'road' surface (mud/water spray instead of smoking - see splash.js).

import { isWheelGrounded } from './wheelContact.js';
import { createPuffPool, wheelSpinLaunch } from './particles/puffPool.js';

const POOL_SIZE = 64; // > wheels * lifetime / interval, so no puff is cut short
const PARTICLES_PER_EMIT = 1;
const EMIT_INTERVAL_S = 0.07;
const PARTICLE_LIFETIME_S = 0.3;
const START_SCALE = 0.12;
const END_SCALE = 0.55;
const BASE_OPACITY = 0.45;
const RISE_SPEED = [0.4, 0.9];
const JITTER_SPEED = [0, 0.35];
const DRAG = 0.98; // velocity multiplier per second
const VELOCITY_INHERIT_FRACTION = 0.1;
const SPIN_LAUNCH_FRACTION = 0.3; // share of wheel spin-slip speed added to launch velocity
const SPIN_LAUNCH_SPEED_MAX = 15;
const COLORS = [0x8a8a8a, 0xc2c2c2];

const spinVelocityScratch = { x: 0, z: 0 };

/** Creates the tyre-smoke effect. Call update() once per rendered frame. */
export function createTireSmoke(scene) {
  // Audio
  const audioContext = new AudioContext();

  const oscillators = [
    { freq: 700,  type: 'sine',     gain: 0.01 },
    { freq: 900, type: 'triangle', gain: 0.008 },
    { freq: 1500, type: 'sawtooth', gain: 0.003 },
  ];

  for (const o of oscillators) {
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc.type = o.type;
    osc.frequency.value = o.freq;
    gain.gain.value = 0;

    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start();

    o.osc = osc;
    o.gainNode = gain;
  }

  const puffs = createPuffPool(scene, {
    size: POOL_SIZE,
    lifetime: PARTICLE_LIFETIME_S,
    startScale: START_SCALE,
    drag: DRAG,
    colors: COLORS,
  });
  let wheelTimers = []; // per-wheel re-arm timers, resized when wheel count changes

  /**
   * @param {number} dt - frame delta in seconds.
   * @param {object|null} vehicle - wheeledVehicle.js vehicle, or null before a car exists.
   * @param {import('cannon-es').World|null} world
   */
  function update(dt, vehicle, world) {
    puffs.update(dt);

    // Audio
    if (audioContext.state === 'suspended') {
      audioContext.resume();
    }

    let maxSlip = 0;

    if (vehicle && world) {
      for (const wheel of vehicle.wheelInfos) {
        if (wheel.sliding && wheel.surface === 'road') {
          maxSlip = Math.max(maxSlip, 1);
        }
      }
    }

    for (const o of oscillators) {
      const now = audioContext.currentTime;
      const variation = Math.sin((now + (Math.random() - 0.5)) * 10) * 100;

      o.osc.frequency.setTargetAtTime(
          o.freq + variation,
          now,
          0.03
      );

      o.gainNode.gain.setTargetAtTime(
          maxSlip * o.gain * (0.8 + 0.2 * Math.sin(now * 18)),
          now,
          0.05
      );
    }

    if (!vehicle || !world) return;
    if (wheelTimers.length !== vehicle.wheelInfos.length) {
      wheelTimers = vehicle.wheelInfos.map(() => 0);
    }

    vehicle.wheelInfos.forEach((wheel, i) => {
      wheelTimers[i] -= dt;
      if (!wheel.sliding || wheel.surface !== 'road') return;
      if (wheelTimers[i] > 0) return;
      if (!isWheelGrounded(world, wheel)) return;

      const pos = wheel.worldTransform.position;
      const extra = wheelSpinLaunch(wheel, SPIN_LAUNCH_FRACTION, SPIN_LAUNCH_SPEED_MAX, spinVelocityScratch);
      for (let n = 0; n < PARTICLES_PER_EMIT; n++) {
        puffs.spawn(pos.x, pos.y - wheel.radius * 0.9, pos.z, {
          opacity: BASE_OPACITY,
          endScale: END_SCALE,
          out: JITTER_SPEED,
          rise: RISE_SPEED,
          inherit: vehicle.chassisBody.velocity,
          inheritFraction: VELOCITY_INHERIT_FRACTION,
          extra,
        });
      }
      wheelTimers[i] = EMIT_INTERVAL_S;
    });
  }

  return { update };
}
