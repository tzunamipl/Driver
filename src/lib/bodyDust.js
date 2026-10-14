// Body dust + thud: one big tan puff from the chassis centre when the body
// itself (not a wheel) hits the ground hard - jump landings, rollovers.
// Driven by app/carManager.js's chassis 'collide' listener via onGroundContact().

import { createPuffPool } from './particles/puffPool.js';

const POOL_SIZE = 16;
const PARTICLE_LIFETIME_S = 0.6;
const START_SCALE = 0.4;
const END_SCALE_MIN = 1.1; // impact speed scales the puff between these
const END_SCALE_MAX = 2.4;
const BASE_OPACITY = 0.55;
const RISE_SPEED = [0.3, 1.1];
const OUTWARD_SPEED = [0.2, 0.6];
const DRAG = 0.85; // velocity multiplier per second
const VELOCITY_INHERIT_FRACTION = 0.4;
const MIN_IMPACT_SPEED = 2.5; // m/s along contact normal; below = resting, no dust
const IMPACT_SPEED_FOR_MAX_BURST = 10;
const EMIT_INTERVAL_S = 0.1; // re-arm cooldown so scraping doesn't emit every step
const POSITION_JITTER = 0.15;
const COLORS = [0x8a7352, 0xc2a775];

// Audio

const audioCtx = new AudioContext();

function playImpactSound(speed) {
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = 'triangle';
  osc.frequency.setValueAtTime(100, now);
  osc.frequency.exponentialRampToValueAtTime(35, now + 0.12);

  gain.gain.setValueAtTime(Math.min(speed / 15, 0.8), now);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start(now);
  osc.stop(now + 0.15);
}

const jitter = () => (Math.random() - 0.5) * POSITION_JITTER;

/** Creates the chassis body-dust effect. Call update() once per rendered frame. */
export function createBodyDust(scene) {
  const puffs = createPuffPool(scene, {
    size: POOL_SIZE,
    lifetime: PARTICLE_LIFETIME_S,
    startScale: START_SCALE,
    drag: DRAG,
    colors: COLORS,
  });
  let rearmTimer = 0;

  /**
   * @param {{x: number, y: number, z: number}} point - spawn point (chassis centre).
   * @param {number} impactSpeed - impact speed along the contact normal (m/s).
   * @param {{x: number, y: number, z: number}} [chassisVelocity] - partially inherited by the dust.
   */
  function onGroundContact(point, impactSpeed, chassisVelocity) {
    if (impactSpeed < MIN_IMPACT_SPEED) return;
    if (rearmTimer > 0) return;
    const speedFrac = Math.min(1, (impactSpeed - MIN_IMPACT_SPEED) / (IMPACT_SPEED_FOR_MAX_BURST - MIN_IMPACT_SPEED));
    puffs.spawn(point.x + jitter(), point.y + jitter(), point.z + jitter(), {
      opacity: BASE_OPACITY,
      endScale: END_SCALE_MIN + (END_SCALE_MAX - END_SCALE_MIN) * speedFrac,
      out: OUTWARD_SPEED,
      rise: RISE_SPEED,
      inherit: chassisVelocity,
      inheritFraction: VELOCITY_INHERIT_FRACTION,
    });
    playImpactSound(impactSpeed);
    rearmTimer = EMIT_INTERVAL_S;
  }

  /** @param {number} dt - frame delta in seconds. */
  function update(dt) {
    rearmTimer -= dt;
    puffs.update(dt);
  }

  return { update, onGroundContact };
}
