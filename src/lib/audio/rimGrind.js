// A flat tyre's bare rim on tarmac/rock: clangs like a banged pot (a hard
// click and thump, then a fixed set of inharmonic metal partials, the high
// ones dying first) once per wheel turn plus random extra bites, over a low
// rumble; louder and quicker with speed. Fed by rimSparks.js.

import { getAudio, createWheelOutput } from './audioContext.js';

const MAX_GAIN = 0.15;
const FULL_SPEED_MPS = 25;
const FADE_S = 0.06;
const RIM_RADIUS_M = 0.15; // only for the clang rate
const RUMBLE = { rate: 0.6, q: 0.7, freq: 140, speedFreq: 160, gain: 0.5 };
// Clang: struck-shell partial ratios on one pot's fundamental (only a small
// jitter per hit - random pitch reads as water drops), ring time per partial.
const CLANG_GAIN = 1;
const CLANG_HZ = 480;
const CLANG_JITTER = 0.03;
const PARTIALS = [
  { ratio: 1, gain: 0.8, ringS: 0.45 },
  { ratio: 2.32, gain: 1, ringS: 0.35 },
  { ratio: 2.76, gain: 0.7, ringS: 0.3 },
  { ratio: 4.07, gain: 0.6, ringS: 0.22 },
  { ratio: 5.4, gain: 0.45, ringS: 0.16 },
  { ratio: 6.8, gain: 0.35, ringS: 0.12 },
  { ratio: 8.2, gain: 0.25, ringS: 0.09 },
];
const RING_AT_SPEED = 0.35; // ring time share at full speed (long rings smear into a drone)
const CLICK = { gain: 1.4, lengthS: 0.012, freq: 3200, q: 0.7 };
const THUMP = { gain: 1.2, lengthS: 0.05, freq: 220 };
const EXTRA_BITE_CHANCE = 0.35; // per turn: a second clang somewhere in it
const MIN_CLANG_GAP_S = 0.015;

function playNoiseBurst(ctx, out, noise, at, { gain, lengthS, freq, q = 0.7 }, type) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, at);
  g.gain.exponentialRampToValueAtTime(0.001, at + lengthS);
  src.connect(filter).connect(g).connect(out);
  src.start(at, Math.random() * (noise.duration - lengthS));
  src.stop(at + lengthS);
}

function playClang(ctx, out, noise, at, gain, ringShare) {
  const bus = ctx.createGain();
  bus.gain.value = gain;
  bus.connect(out);
  playNoiseBurst(ctx, bus, noise, at, CLICK, 'bandpass');
  playNoiseBurst(ctx, bus, noise, at, THUMP, 'lowpass');
  const f0 = CLANG_HZ * (1 + (Math.random() - 0.5) * 2 * CLANG_JITTER);
  for (const partial of PARTIALS) {
    const ringS = partial.ringS * ringShare;
    const osc = ctx.createOscillator();
    osc.frequency.value = f0 * partial.ratio;
    const g = ctx.createGain();
    g.gain.setValueAtTime(partial.gain * (0.7 + 0.3 * Math.random()) / PARTIALS.length, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + ringS);
    osc.connect(g).connect(bus);
    osc.start(at, 0);
    osc.stop(at + ringS);
  }
}

export function createRimGrindSound() {
  let rumble = null;
  let output = null;
  let phase = 0;
  let extraAt = -1; // phase of this turn's extra bite, -1 = none
  let lastClang = -Infinity;

  function build(ctx, out, noise) {
    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    source.buffer = noise;
    source.loop = true;
    source.playbackRate.value = RUMBLE.rate;
    filter.type = 'lowpass';
    filter.Q.value = RUMBLE.q;
    filter.frequency.value = RUMBLE.freq;
    gain.gain.value = 0;
    source.connect(filter).connect(gain).connect(out);
    source.start(0, Math.random() * noise.duration);
    return { filter, gain };
  }

  /**
   * @param {number} dt - frame delta in seconds.
   * @param {number} speed - fastest grinding rim's rub speed (m/s), 0 = none.
   * @param {number} [side] - that rim's side, -1 left .. 1 right.
   */
  function update(dt, speed, side = 0) {
    const speedFrac = Math.min(1, speed / FULL_SPEED_MPS);
    const level = speed > 0 ? 0.35 + 0.65 * speedFrac : 0;
    const prevPhase = phase;
    phase += (speed / (2 * Math.PI * RIM_RADIUS_M)) * dt;
    const wrapped = phase >= 1;
    const extraHit = extraAt >= 0 && prevPhase < extraAt && phase >= extraAt;
    phase %= 1;

    const audio = getAudio();
    if (!audio) return;
    const { ctx, noise } = audio;
    if (!rumble) {
      if (level <= 0) return; // don't start the graph until first needed
      output = createWheelOutput();
      rumble = build(ctx, output.input, noise);
    }
    if (level > 0) output.setSide(side);
    const now = ctx.currentTime;
    rumble.filter.frequency.setTargetAtTime(RUMBLE.freq + RUMBLE.speedFreq * speedFrac, now, 0.03);
    rumble.gain.gain.setTargetAtTime(MAX_GAIN * RUMBLE.gain * level, now, FADE_S);
    if (level <= 0 || !(wrapped || extraHit) || now - lastClang < MIN_CLANG_GAP_S) return;
    if (wrapped) extraAt = Math.random() < EXTRA_BITE_CHANCE ? 0.3 + Math.random() * 0.4 : -1;
    lastClang = now;
    const ringShare = 1 - (1 - RING_AT_SPEED) * speedFrac;
    playClang(ctx, output.input, noise, now, MAX_GAIN * CLANG_GAIN * level * (0.6 + 0.4 * Math.random()), ringShare);
  }

  return { update };
}
