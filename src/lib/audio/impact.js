// Body thud: a sub-bass drop, a punchy mid knock and a burst of low-passed
// noise (crunch), all scaled by impact speed.

import { getAudio } from './audioContext.js';

const MIN_SPEED = 2.5; // m/s; bodyDust's resting cutoff
const SPEED_FOR_MAX = 10;
const MIN_GAIN = 0.35;
const MAX_GAIN = 2.9;
const PITCH = 0.3; // deep, but sub still starts above ~50 Hz
const COOLDOWN_S = 0.1; // collide events fire every step while scraping a wall

/**
 * Shared thud voice. `level` 0..1 scales loudness, length and crunch;
 * `pitch` multiplies every frequency (lighter hits sit higher), `length`
 * stretches every decay, `knock` scales the attack transient. `destination`
 * defaults to the own car's bus.
 */
export function playThud(level, { gain = 1, pitch = 1, crunch = 1, length = 1, knock: knockLevel = 1, attack = 0.004, destination } = {}) {
  const audio = getAudio();
  if (!audio) return;
  const { ctx, buses, noise } = audio;
  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.value = gain;
  out.connect(destination ?? buses.carSfx);

  // Sub: sine sweeping down, carries the weight.
  const subLen = (0.18 + 0.22 * level) * length;
  const sub = ctx.createOscillator();
  const subGain = ctx.createGain();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(90 * pitch, now);
  sub.frequency.exponentialRampToValueAtTime(28 * pitch, now + subLen);
  subGain.gain.setValueAtTime(0.0001, now);
  subGain.gain.exponentialRampToValueAtTime(1, now + attack);
  subGain.gain.exponentialRampToValueAtTime(0.001, now + subLen);
  sub.connect(subGain).connect(out);
  sub.start(now);
  sub.stop(now + subLen);

  // Knock: short triangle for the attack transient small speakers can play.
  if (knockLevel > 0) {
    const knockLen = 0.09 * length;
    const knock = ctx.createOscillator();
    const knockGain = ctx.createGain();
    knock.type = 'triangle';
    knock.frequency.setValueAtTime(220 * pitch, now);
    knock.frequency.exponentialRampToValueAtTime(70 * pitch, now + knockLen * 0.66);
    knockGain.gain.setValueAtTime(0.7 * knockLevel, now);
    knockGain.gain.exponentialRampToValueAtTime(0.001, now + knockLen);
    knock.connect(knockGain).connect(out);
    knock.start(now);
    knock.stop(now + knockLen);
  }

  // Crunch: noise burst, brighter and longer for harder hits.
  if (crunch > 0) {
    const noiseLen = (0.08 + 0.17 * level) * length;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime((600 + 1800 * level) * pitch, now);
    filter.frequency.exponentialRampToValueAtTime(150 * pitch, now + noiseLen);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.6 * crunch * (0.4 + 0.6 * level), now);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + noiseLen);
    src.connect(filter).connect(noiseGain).connect(out);
    src.start(now, Math.random() * 0.5);
    src.stop(now + noiseLen);
  }
}

export function createImpactSound() {
  let lastPlay = -Infinity;

  /** @param {number} speed - impact speed along the contact normal (m/s). */
  function play(speed) {
    if (speed < MIN_SPEED) return;
    const audio = getAudio();
    if (!audio || audio.ctx.currentTime - lastPlay < COOLDOWN_S) return;
    lastPlay = audio.ctx.currentTime;
    const level = Math.min(1, Math.max(0, (speed - MIN_SPEED) / (SPEED_FOR_MAX - MIN_SPEED)));
    playThud(level, { gain: MIN_GAIN + (MAX_GAIN - MIN_GAIN) * level, pitch: PITCH });
  }

  return { play };
}
