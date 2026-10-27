// Tyre screech, audible while any wheel slides on a hard surface (SQUEAL_SURFACES;
// loose ground crunches instead, gravelSpin.js). Two voice sets mixed by slip kind: a high sustained squeal
// for sideways/locked slides, a lower chattering scrub for power wheelspin.

import { getAudio, createWheelOutput } from './audioContext.js';
import { wheelSide } from '../wheelContact.js';

const SQUEAL_SURFACES = new Set(['road', 'cobblestone', 'rock', 'builtUp']);

const SLIDE_TONES = [
  { freq: 700, type: 'sine', gain: 0.01 },
  { freq: 900, type: 'triangle', gain: 0.008 },
  { freq: 1500, type: 'sawtooth', gain: 0.003 },
];
const SPIN_TONES = [
  { freq: 380, type: 'sawtooth', gain: 0.006 },
  { freq: 520, type: 'triangle', gain: 0.008 },
  { freq: 1100, type: 'square', gain: 0.0015 },
];
const SLIDE_WOBBLE_HZ = 18;
const SPIN_CHATTER_HZ = 31; // audio-rate LFO: too fast for per-frame gain updates
const SPIN_CHATTER_DEPTH = 0.4;
const SPIN_PITCH_PER_MPS = 0.015; // spin tones rise with tread overspeed...
const SPIN_PITCH_MAX = 1.4; // ...up to this multiple

export function createTireSqueal() {
  const audio = getAudio();
  if (!audio) return { update() {} };
  const { ctx } = audio;
  const output = createWheelOutput();

  // Spin voices go through a bus whose gain the chatter LFO wobbles.
  const spinBus = ctx.createGain();
  spinBus.gain.value = 1 - SPIN_CHATTER_DEPTH;
  spinBus.connect(output.input);
  const chatter = ctx.createOscillator();
  chatter.frequency.value = SPIN_CHATTER_HZ;
  const chatterDepth = ctx.createGain();
  chatterDepth.gain.value = SPIN_CHATTER_DEPTH;
  chatter.connect(chatterDepth);
  chatterDepth.connect(spinBus.gain);
  chatter.start();

  function createVoices(tones, output) {
    return tones.map((tone) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = tone.type;
      osc.frequency.value = tone.freq;
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(output);
      osc.start();
      return { ...tone, osc, gainNode: gain };
    });
  }
  const slideVoices = createVoices(SLIDE_TONES, output.input);
  const spinVoices = createVoices(SPIN_TONES, spinBus);

  /** @param {object|null} vehicle - wheeledVehicle.js vehicle, or null. */
  function update(vehicle) {
    // Per sliding hard-surface wheel, split 1 between spin and slide by its slip direction.
    let spin = 0;
    let slide = 0;
    let spinSpeed = 0;
    let sideSum = 0;
    for (const w of vehicle?.wheelInfos ?? []) {
      if (!w.sliding || !SQUEAL_SURFACES.has(w.surface)) continue;
      const long = Math.abs(w.spinSlipSpeed ?? 0);
      const total = Math.hypot(long, w.sideSlipSpeed ?? 0);
      const spinShare = w.wheelspin && total > 1e-3 ? long / total : 0;
      spin += spinShare;
      slide += 1 - spinShare;
      sideSum += wheelSide(w);
      if (w.wheelspin) spinSpeed = Math.max(spinSpeed, long);
    }
    if (spin + slide > 0) output.setSide(sideSum / (spin + slide));
    const spinLevel = Math.min(1, spin);
    const slideLevel = Math.min(1, slide);
    const spinPitch = Math.min(SPIN_PITCH_MAX, 1 + spinSpeed * SPIN_PITCH_PER_MPS);

    const now = ctx.currentTime;
    for (const v of slideVoices) {
      const variation = Math.sin((now + (Math.random() - 0.5)) * 10) * 100;
      v.osc.frequency.setTargetAtTime(v.freq + variation, now, 0.03);
      const level = slideLevel * v.gain * (0.8 + 0.2 * Math.sin(now * SLIDE_WOBBLE_HZ));
      v.gainNode.gain.setTargetAtTime(level, now, 0.05);
    }
    for (const v of spinVoices) {
      const variation = (Math.random() - 0.5) * 60;
      v.osc.frequency.setTargetAtTime(v.freq * spinPitch + variation, now, 0.02);
      v.gainNode.gain.setTargetAtTime(spinLevel * v.gain, now, 0.04);
    }
  }

  return { update };
}
