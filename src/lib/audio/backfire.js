// Exhaust backfire: a low muffled bang (lowpassed noise + falling thump),
// sometimes trailed by a few sharp crackles. Local car only (carSfx).

import { getAudio } from './audioContext.js';

const BANG_GAIN = 0.45;
const BANG_LEN_S = 0.11;
const BANG_CUTOFF_HZ = [700, 1400]; // random per bang
const THUMP_HZ = [140, 45];
const CRACKLE_CHANCE = 0.6;
const CRACKLES = [1, 4];
const CRACKLE_SPREAD_S = 0.12;
const CRACKLE_GAIN = 0.3;

function bang(ctx, out, noise, at, strength) {
  const len = BANG_LEN_S * (0.7 + Math.random() * 0.6);
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = BANG_CUTOFF_HZ[0] + Math.random() * (BANG_CUTOFF_HZ[1] - BANG_CUTOFF_HZ[0]);
  const g = ctx.createGain();
  g.gain.setValueAtTime(BANG_GAIN * strength, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + len);
  src.connect(filter).connect(g).connect(out);
  src.start(at, Math.random() * 0.5);
  src.stop(at + len);

  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(THUMP_HZ[0] * (0.85 + Math.random() * 0.3), at);
  osc.frequency.exponentialRampToValueAtTime(THUMP_HZ[1], at + len);
  const tg = ctx.createGain();
  tg.gain.setValueAtTime(BANG_GAIN * strength, at);
  tg.gain.exponentialRampToValueAtTime(0.001, at + len * 1.3);
  osc.connect(tg).connect(out);
  osc.start(at);
  osc.stop(at + len * 1.3);
}

function crackle(ctx, out, noise, at, strength) {
  const len = 0.01 + Math.random() * 0.015;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1500 + Math.random() * 2500;
  filter.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(CRACKLE_GAIN * strength * (0.5 + Math.random() * 0.5), at);
  g.gain.exponentialRampToValueAtTime(0.001, at + len);
  src.connect(filter).connect(g).connect(out);
  src.start(at, Math.random() * 0.5);
  src.stop(at + len);
}

export function createBackfireSound() {
  return {
    /** strength: 0..1 (gear-change pops are full, overrun pops scale with rpm). */
    play(strength = 1) {
      const audio = getAudio();
      if (!audio) return;
      const { ctx, buses, noise } = audio;
      const now = ctx.currentTime;
      bang(ctx, buses.carSfx, noise, now, strength);
      if (Math.random() > CRACKLE_CHANCE) return;
      const count = CRACKLES[0] + Math.floor(Math.random() * (CRACKLES[1] - CRACKLES[0] + 1));
      for (let i = 0; i < count; i++) crackle(ctx, buses.carSfx, noise, now + 0.03 + CRACKLE_SPREAD_S * Math.random(), strength);
    },
  };
}
