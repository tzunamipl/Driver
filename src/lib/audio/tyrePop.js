// Tyre puncture: a sharp bang (noise crack over a low thump), then the air
// rushing out as a hiss that falls in pitch and fades, with a crackle of
// sparks as the rim hits the ground.

import { getAudio, createWheelOutput } from './audioContext.js';
import { playThud } from './impact.js';

const BANG_GAIN = 1.2;
const BANG_LEN_S = 0.07;
const HISS_GAIN = 0.35;
const HISS_LEN_S = 1.4;
const HISS_HZ = [5200, 1800]; // band centre over the hiss
const CRACKLES = 10;
const CRACKLE_SPREAD_S = 0.35;
const CRACKLE_GAIN = 0.22;
const COOLDOWN_S = 0.05; // two tyres on one hit still read as two pops

function playBang(ctx, out, now) {
  const { noise } = getAudio();
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 2500 * (0.85 + Math.random() * 0.3);
  const g = ctx.createGain();
  g.gain.setValueAtTime(BANG_GAIN, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + BANG_LEN_S);
  src.connect(filter).connect(g).connect(out);
  src.start(now, Math.random() * 0.5);
  src.stop(now + BANG_LEN_S);
}

function playHiss(ctx, out, now) {
  const { noise } = getAudio();
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 0.9;
  filter.frequency.setValueAtTime(HISS_HZ[0], now);
  filter.frequency.exponentialRampToValueAtTime(HISS_HZ[1], now + HISS_LEN_S);
  const g = ctx.createGain();
  g.gain.setValueAtTime(HISS_GAIN, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, now + HISS_LEN_S);
  src.connect(filter).connect(g).connect(out);
  src.start(now, Math.random() * 0.5);
  src.stop(now + HISS_LEN_S);
}

function playCrackle(ctx, out, at) {
  const { noise } = getAudio();
  const len = 0.01 + Math.random() * 0.012;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 3500 + Math.random() * 3500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(CRACKLE_GAIN * (0.4 + Math.random() * 0.6), at);
  g.gain.exponentialRampToValueAtTime(0.001, at + len);
  src.connect(filter).connect(g).connect(out);
  src.start(at, Math.random() * 0.5);
  src.stop(at + len);
}

export function createTyrePopSound() {
  let lastAt = 0;
  // One per side so two tyres popping together keep their own speakers.
  const outputs = new Map();
  return {
    /** @param {number} [side] - popped wheel's side, -1 left .. 1 right. */
    play(side = 0) {
      const audio = getAudio();
      if (!audio) return;
      const { ctx } = audio;
      const now = ctx.currentTime;
      if (now - lastAt < COOLDOWN_S) return;
      lastAt = now;
      if (!outputs.has(side)) {
        outputs.set(side, createWheelOutput());
        outputs.get(side).setSide(side, true);
      }
      const out = outputs.get(side).input;
      playBang(ctx, out, now);
      playThud(0.6, { gain: 1.2, pitch: 0.8, crunch: 0, knock: 1, length: 0.5, attack: 0.002, destination: out });
      playHiss(ctx, out, now);
      for (let i = 0; i < CRACKLES; i++) playCrackle(ctx, out, now + 0.02 + CRACKLE_SPREAD_S * Math.random() ** 1.5);
    },
  };
}
