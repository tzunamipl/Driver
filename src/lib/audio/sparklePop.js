// Sparkles thrown at a passed control: a sharp pop (noise burst + falling thump),
// then a short crackle of tiny ticks as the streaks fly out.

import { getAudio } from './audioContext.js';

const POP_GAIN = 0.3;
const POP_LEN_S = 0.09;
const THUMP_HZ = [220, 60]; // falls over the pop
const CRACKLES = 14;
const CRACKLE_SPREAD_S = 0.6;
const CRACKLE_GAIN = 0.25;

function pop(ctx, out, at) {
  const { noise } = getAudio();
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1800 * (0.85 + Math.random() * 0.3);
  filter.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(POP_GAIN, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + POP_LEN_S);
  src.connect(filter).connect(g).connect(out);
  src.start(at, Math.random() * 0.5);
  src.stop(at + POP_LEN_S);

  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(THUMP_HZ[0], at);
  osc.frequency.exponentialRampToValueAtTime(THUMP_HZ[1], at + POP_LEN_S);
  const tg = ctx.createGain();
  tg.gain.setValueAtTime(POP_GAIN * 0.8, at);
  tg.gain.exponentialRampToValueAtTime(0.001, at + POP_LEN_S * 1.4);
  osc.connect(tg).connect(out);
  osc.start(at);
  osc.stop(at + POP_LEN_S * 1.4);
}

function crackle(ctx, out, at) {
  const { noise } = getAudio();
  const len = 0.012 + Math.random() * 0.012;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 3500 + Math.random() * 3000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(CRACKLE_GAIN * (0.4 + Math.random() * 0.6), at);
  g.gain.exponentialRampToValueAtTime(0.001, at + len);
  src.connect(filter).connect(g).connect(out);
  src.start(at, Math.random() * 0.5);
  src.stop(at + len);
}

export function createSparklePop() {
  return {
    play() {
      const audio = getAudio();
      if (!audio) return;
      const { ctx, buses } = audio;
      const now = ctx.currentTime;
      const out = ctx.createGain();
      out.connect(buses.sfx);
      pop(ctx, out, now);
      // Crackles thin out as the sparks spread.
      for (let i = 0; i < CRACKLES; i++) crackle(ctx, out, now + 0.05 + CRACKLE_SPREAD_S * Math.random() ** 1.6);
    },
  };
}
