// Mechanical part damaged by a hit (radiator, sump, gearbox): a heavy, dull
// metal clunk - a low thud under short, damped inharmonic partials of a thick
// casting - then a bright clank, a part-specific layer and loose bits rattling,
// started just after the crash thud so they read as a separate event over it.

import { getAudio } from './audioContext.js';
import { playThud } from './impact.js';

const COOLDOWN_S = 0.15; // one crash damages several parts over a few steps
const MIN_LEVEL = 0.4;
// Behind the crash thud's attack so the breakage isn't masked by it.
const DELAY_S = 0.06;
// Bending-mode ratios of a bar, decays short: a thick part doesn't ring.
const CLUNK_PARTIALS = [
  { ratio: 1, gain: 1, decay: 0.22 },
  { ratio: 2.76, gain: 0.55, decay: 0.14 },
  { ratio: 5.4, gain: 0.3, decay: 0.08 },
];
const CLUNK_BASE_HZ = 170;
const CLUNK_GAIN = 0.7;
// Mid-band clank: sits above the crash thud's lowpassed crunch, so it carries on small speakers.
const CLANK_PARTIALS = [
  { ratio: 1, gain: 1, decay: 0.3 },
  { ratio: 1.63, gain: 0.7, decay: 0.22 },
  { ratio: 2.41, gain: 0.45, decay: 0.16 },
  { ratio: 3.9, gain: 0.3, decay: 0.1 },
];
const CLANK_BASE_HZ = 640;
const CLANK_GAIN = 0.32;
const RATTLE_GAIN = 0.5;

function playPartials(ctx, out, partials, base, start, length, type = 'triangle') {
  for (const { ratio, gain, decay } of partials) {
    const len = decay * length;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = base * ratio * (0.98 + Math.random() * 0.04);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, start + len);
    osc.connect(g).connect(out);
    osc.start(start);
    osc.stop(start + len);
  }
}

function playNoise(ctx, noise, out, { start, length, type = 'bandpass', freq, Q = 1, gain, freqEnd }) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(freq, start);
  if (freqEnd) filter.frequency.exponentialRampToValueAtTime(freqEnd, start + length);
  filter.Q.value = Q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, start);
  g.gain.exponentialRampToValueAtTime(0.001, start + length);
  src.connect(filter).connect(g).connect(out);
  src.start(start, Math.random() * 0.5);
  src.stop(start + length);
}

// Radiator: thin core and tanks crumpling (crackle), then a burst of escaping coolant.
function playRadiator(ctx, noise, out, start, level) {
  const crackles = 5 + Math.round(5 * level);
  for (let i = 0; i < crackles; i++) {
    playNoise(ctx, noise, out, {
      start: start + Math.random() * 0.18, length: 0.015 + Math.random() * 0.02,
      freq: 2500 + Math.random() * 3000, Q: 3, gain: 0.5 + 0.5 * Math.random(),
    });
  }
  playNoise(ctx, noise, out, { start: start + 0.05, length: 0.5 + 0.4 * level, type: 'highpass', freq: 4000, Q: 0.7, gain: 0.35 * level });
}

// Sump: a hollow pan dented from below - a low resonant bonk with a pitch drop.
function playSump(ctx, noise, out, start, level) {
  const len = 0.35 + 0.25 * level;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(260, start);
  osc.frequency.exponentialRampToValueAtTime(150, start + len);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(1.1, start + 0.004);
  g.gain.exponentialRampToValueAtTime(0.001, start + len);
  osc.connect(g).connect(out);
  osc.start(start);
  osc.stop(start + len);
  playNoise(ctx, noise, out, { start, length: 0.12, type: 'lowpass', freq: 1500, freqEnd: 300, gain: 0.6 });
}

// Gearbox: teeth crunching - a few quick grinding pulses through a mid band.
function playGearbox(ctx, noise, out, start, level) {
  const len = 0.22 + 0.2 * level;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(55 + 20 * Math.random(), start);
  osc.frequency.exponentialRampToValueAtTime(30, start + len);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 1100;
  filter.Q.value = 1.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(1.4, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, start + len);
  osc.connect(filter).connect(g).connect(out);
  osc.start(start);
  osc.stop(start + len);
}

const PART_LAYERS = { radiator: playRadiator, sump: playSump, gearbox: playGearbox };

function playClunk(level, part) {
  const audio = getAudio();
  if (!audio) return;
  const { ctx, buses, noise } = audio;
  const now = ctx.currentTime + DELAY_S;
  const out = ctx.createGain();
  out.gain.value = CLUNK_GAIN * (0.5 + 0.5 * level);
  out.connect(buses.carSfx);
  // Random detune so repeated hits don't play one note.
  const detune = 0.88 + Math.random() * 0.24;
  const base = CLUNK_BASE_HZ * detune;
  const length = 0.7 + 0.6 * level;
  playPartials(ctx, out, CLUNK_PARTIALS, base, now, length);
  const clank = ctx.createGain();
  clank.gain.value = CLANK_GAIN;
  clank.connect(out);
  playPartials(ctx, clank, CLANK_PARTIALS, CLANK_BASE_HZ * detune, now, length);
  // Strike: mid-band noise tick, the metal-on-metal contact.
  playNoise(ctx, noise, out, { start: now, length: 0.06, freq: base * 8, Q: 1.2, gain: 0.9 });
  PART_LAYERS[part]?.(ctx, noise, out, now, level);
  // Loose bits settling: a few fading ticks after the hit.
  const ticks = 2 + Math.round(4 * level);
  for (let i = 0; i < ticks; i++) {
    const t = 0.1 + (i + Math.random()) * (0.35 / ticks);
    playNoise(ctx, noise, out, {
      start: now + t, length: 0.025, freq: 1800 + Math.random() * 2200, Q: 4,
      gain: RATTLE_GAIN * (1 - t) * (0.5 + 0.5 * Math.random()),
    });
  }
}

export function createPartClunkSound() {
  let lastPlay = -Infinity;

  /**
   * @param {number} level - 0..1 share of the part's health the hit took (scaled up).
   * @param {'radiator' | 'sump' | 'gearbox'} [part] - the part hit hardest, for its own layer.
   */
  function play(level, part) {
    if (!(level > 0)) return;
    const audio = getAudio();
    if (!audio || audio.ctx.currentTime - lastPlay < COOLDOWN_S) return;
    lastPlay = audio.ctx.currentTime;
    const l = MIN_LEVEL + (1 - MIN_LEVEL) * Math.min(1, level);
    playThud(l, { gain: 0.9 + 0.8 * l, pitch: 0.68, crunch: 0.3, length: 0.7, knock: 1.5 });
    playClunk(l, part);
  }

  return { play };
}
