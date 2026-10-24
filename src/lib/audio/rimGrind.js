// A flat tyre's bare rim grinding on tarmac/rock: a harsh metallic screech
// (narrow high resonances over noise) on a low rumble, louder and brighter
// with rubbing speed, chattering once per wheel turn. Fed by rimSparks.js.

import { getAudio } from './audioContext.js';

const MAX_GAIN = 0.11;
const FULL_SPEED_MPS = 25;
const FADE_S = 0.06;
const RIM_RADIUS_M = 0.25; // only for the chatter rate
const CHATTER_DEPTH = 0.35; // gain dip between rim bites

const LAYERS = [
  // Rumble.
  { type: 'lowpass', rate: 0.6, q: 0.7, freq: 180, speedFreq: 220, gain: 0.8 },
  // Steel-on-stone screech.
  { type: 'bandpass', rate: 1.0, q: 16, freq: 3100, speedFreq: 900, gain: 1.4 },
  { type: 'bandpass', rate: 1.13, q: 20, freq: 4700, speedFreq: 1200, gain: 1.0 },
  { type: 'bandpass', rate: 0.94, q: 12, freq: 2200, speedFreq: 500, gain: 0.9 },
  // Hiss of the sparks, at speed.
  { type: 'highpass', rate: 1.3, q: 0.5, freq: 6500, speedFreq: 0, gain: 0.35, speedOnly: true },
];
const WANDER = 0.08; // random +/- share of each resonance's frequency, re-rolled per frame

export function createRimGrindSound() {
  let voices = null;
  let phase = 0;

  function build(ctx, out, noise) {
    return LAYERS.map((layer) => {
      const source = ctx.createBufferSource();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      source.buffer = noise;
      source.loop = true;
      source.playbackRate.value = layer.rate;
      filter.type = layer.type;
      filter.Q.value = layer.q;
      filter.frequency.value = layer.freq;
      gain.gain.value = 0;
      source.connect(filter).connect(gain).connect(out);
      source.start(0, Math.random() * noise.duration);
      return { layer, filter, gain };
    });
  }

  /**
   * @param {number} dt - frame delta in seconds.
   * @param {number} speed - fastest grinding rim's rub speed (m/s), 0 = none.
   */
  function update(dt, speed) {
    const speedFrac = Math.min(1, speed / FULL_SPEED_MPS);
    const level = speed > 0 ? 0.35 + 0.65 * speedFrac : 0;
    phase = (phase + (speed / (2 * Math.PI * RIM_RADIUS_M)) * dt) % 1;
    const chatter = 1 - CHATTER_DEPTH * Math.pow(Math.sin(phase * Math.PI), 4);

    const audio = getAudio();
    if (!audio) return;
    const { ctx, buses, noise } = audio;
    if (!voices) {
      if (level <= 0) return; // don't start the graph until first needed
      voices = build(ctx, buses.carSfx, noise);
    }
    const now = ctx.currentTime;
    for (const v of voices) {
      const { layer } = v;
      const wander = layer.type === 'bandpass' ? 1 + (Math.random() - 0.5) * 2 * WANDER : 1;
      v.filter.frequency.setTargetAtTime((layer.freq + layer.speedFreq * speedFrac) * wander, now, 0.03);
      const layerLevel = layer.speedOnly ? level * speedFrac : level;
      v.gain.gain.setTargetAtTime(MAX_GAIN * layer.gain * layerLevel * chatter * (0.75 + 0.25 * Math.random()), now, FADE_S);
    }
  }

  return { update };
}
