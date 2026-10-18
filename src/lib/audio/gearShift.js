// Manual gearbox sounds: 'detach' (lever pulled out of gear), 'attach' (gear
// clunking in), 'grind' (synchro refusing) and 'range' (range lever detent +
// air valve). Scaled by vehicle mass: small cars click, trucks clunk lower
// and longer with a gritty gear-tooth rattle.

import { getAudio } from './audioContext.js';

const SMALL_MASS = 700;
const BIG_MASS = 15000;
const DEFAULT_MASS = 1300;
const GRIND_COOLDOWN_S = 0.3;

/** 0 (city car) .. 1 (heavy truck), log-scaled. */
function sizeOf(mass) {
  const t = Math.log((mass ?? DEFAULT_MASS) / SMALL_MASS) / Math.log(BIG_MASS / SMALL_MASS);
  return Math.min(1, Math.max(0, t));
}

export function createGearShiftSound() {
  let lastGrindAt = -Infinity;

  /** Filtered noise burst with an exponential decay. */
  function click(audio, t, freq, length, gain, q = 2) {
    const { ctx, buses, noise } = audio;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + length);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.connect(filter).connect(env).connect(buses.carSfx);
    src.start(t, Math.random() * 0.8, length + 0.02);
  }

  /** Low body knock: a sine dropping in pitch. */
  function thump(audio, t, freq, length, gain) {
    const { ctx, buses } = audio;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(freq * 1.8, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + length * 0.5);
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + length);
    osc.connect(env).connect(buses.carSfx);
    osc.start(t);
    osc.stop(t + length + 0.02);
  }

  /** Gear-tooth grit: band-passed noise chopped by a square wave at `rateHz`. */
  function grit(audio, t, freq, rateHz, length, gain) {
    const { ctx, buses, noise } = audio;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = 1.4;
    const chop = ctx.createGain();
    chop.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = rateHz;
    const depth = ctx.createGain();
    depth.gain.value = 0.5;
    lfo.connect(depth).connect(chop.gain);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.015);
    env.gain.exponentialRampToValueAtTime(0.001, t + length);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.connect(filter).connect(chop).connect(env).connect(buses.carSfx);
    src.start(t, Math.random() * 0.5, length + 0.03);
    lfo.start(t);
    lfo.stop(t + length + 0.03);
  }

  /**
   * Synchro grind: noise through metallic resonances, amplitude-chopped by a
   * sawtooth at the tooth-clash rate (sagging as the gears drag each other),
   * with a slow wobble so it rasps rather than buzzing evenly.
   */
  function rasp(audio, t, toothHz, resonances, length, gain) {
    const { ctx, buses, noise } = audio;
    const end = t + length;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    env.gain.setValueAtTime(gain, t + length * 0.6);
    env.gain.exponentialRampToValueAtTime(0.001, end);
    env.connect(buses.carSfx);

    const chop = ctx.createGain();
    chop.gain.value = 0.5;
    chop.connect(env);
    const teeth = ctx.createOscillator();
    teeth.type = 'sawtooth';
    teeth.frequency.setValueAtTime(toothHz, t);
    teeth.frequency.exponentialRampToValueAtTime(toothHz * 0.6, end);
    const teethDepth = ctx.createGain();
    teethDepth.gain.value = 0.5;
    teeth.connect(teethDepth).connect(chop.gain);
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 11 + Math.random() * 6;
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = 0.25;
    wobble.connect(wobbleDepth).connect(chop.gain);

    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    for (const freq of resonances) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq * (0.95 + Math.random() * 0.1);
      filter.Q.value = 5;
      src.connect(filter).connect(chop);
    }
    src.start(t, Math.random() * 0.5);
    src.stop(end + 0.03);
    for (const osc of [teeth, wobble]) {
      osc.start(t);
      osc.stop(end + 0.03);
    }
  }

  /** Air valve: a short high-passed noise puff. */
  function hiss(audio, t, length, gain) {
    const { ctx, buses, noise } = audio;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 3000;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    env.gain.exponentialRampToValueAtTime(0.001, t + length);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.connect(filter).connect(env).connect(buses.carSfx);
    src.start(t, Math.random() * 0.5, length + 0.03);
  }

  /** type: 'detach' | 'attach' | 'grind' | 'range'; mass in kg picks the size. */
  function play(type, mass) {
    const audio = getAudio();
    if (!audio) return;
    const s = sizeOf(mass);
    const now = audio.ctx.currentTime;
    if (type === 'detach') {
      click(audio, now, 2400 - 1300 * s, 0.03 + 0.04 * s, 0.22 + 0.12 * s);
      thump(audio, now, 150 - 80 * s, 0.05 + 0.07 * s, 0.12 + 0.12 * s);
      if (s > 0.3) grit(audio, now, 900 - 400 * s, 70 - 30 * s, 0.05 + 0.1 * s, 0.1 * s);
    } else if (type === 'attach') {
      click(audio, now, 1700 - 900 * s, 0.04 + 0.05 * s, 0.3 + 0.15 * s);
      thump(audio, now + 0.005, 120 - 65 * s, 0.09 + 0.14 * s, 0.3 + 0.2 * s);
      grit(audio, now + 0.01, 1100 - 550 * s, 90 - 45 * s, 0.04 + 0.16 * s, 0.05 + 0.25 * s);
    } else if (type === 'range') {
      click(audio, now, 2800 - 800 * s, 0.025, 0.18, 3);
      hiss(audio, now + 0.03, 0.12 + 0.12 * s, 0.05 + 0.07 * s);
    } else if (type === 'grind') {
      if (now - lastGrindAt < GRIND_COOLDOWN_S) return;
      lastGrindAt = now;
      const length = 0.45 + 0.3 * s;
      const base = 2300 - 1100 * s;
      rasp(audio, now, 260 - 130 * s, [base, base * 1.63, base * 2.37], length, 0.5 + 0.2 * s);
    }
  }

  return { play };
}
