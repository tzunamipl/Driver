// Mechanical part damaged by a hit (radiator, sump, gearbox): a heavy, dull
// metal clunk - a low thud under short, damped inharmonic partials of a thick
// casting, so it reads as something breaking rather than a ringing sign.

import { getAudio } from './audioContext.js';
import { playThud } from './impact.js';

const COOLDOWN_S = 0.15; // one crash damages several parts over a few steps
const MIN_LEVEL = 0.25;
// Bending-mode ratios of a bar, decays short: a thick part doesn't ring.
const CLUNK_PARTIALS = [
  { ratio: 1, gain: 1, decay: 0.22 },
  { ratio: 2.76, gain: 0.55, decay: 0.14 },
  { ratio: 5.4, gain: 0.3, decay: 0.08 },
];
const CLUNK_BASE_HZ = 210;
const CLUNK_GAIN = 0.45;

function playClunk(level) {
  const audio = getAudio();
  if (!audio) return;
  const { ctx, buses, noise } = audio;
  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.value = CLUNK_GAIN * (0.5 + 0.5 * level);
  out.connect(buses.carSfx);
  // Random detune so repeated hits don't play one note.
  const base = CLUNK_BASE_HZ * (0.88 + Math.random() * 0.24);
  const length = 0.7 + 0.6 * level;
  for (const { ratio, gain, decay } of CLUNK_PARTIALS) {
    const len = decay * length;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = base * ratio * (0.98 + Math.random() * 0.04);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, now + len);
    osc.connect(g).connect(out);
    osc.start(now);
    osc.stop(now + len);
  }
  // Strike: mid-band noise tick, the metal-on-metal contact.
  const tickLen = 0.06;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = base * 8;
  filter.Q.value = 1.2;
  const tickGain = ctx.createGain();
  tickGain.gain.setValueAtTime(0.9, now);
  tickGain.gain.exponentialRampToValueAtTime(0.001, now + tickLen);
  src.connect(filter).connect(tickGain).connect(out);
  src.start(now, Math.random() * 0.5);
  src.stop(now + tickLen);
}

export function createPartClunkSound() {
  let lastPlay = -Infinity;

  /** @param {number} level - 0..1 share of the part's health the hit took (scaled up). */
  function play(level) {
    if (!(level > 0)) return;
    const audio = getAudio();
    if (!audio || audio.ctx.currentTime - lastPlay < COOLDOWN_S) return;
    lastPlay = audio.ctx.currentTime;
    const l = MIN_LEVEL + (1 - MIN_LEVEL) * Math.min(1, level);
    playThud(l, { gain: 0.6 + 0.6 * l, pitch: 0.8, crunch: 0.3, length: 0.6, knock: 1.3 });
    playClunk(l);
  }

  return { play };
}
