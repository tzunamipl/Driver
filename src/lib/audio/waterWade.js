// Wading through water: a continuous wash of filtered noise layers, louder and
// brighter with speed. Filters and levels drift randomly so it never pulses.

import { getAudio } from './audioContext.js';

const MAX_GAIN = 0.12;
const FULL_SPEED_MPS = 12; // speed at which the wash reaches full level
const IDLE_LEVEL = 0.12; // gentle lapping while stopped in water
const FADE_S = 0.12;

// Two noise copies at different playback rates so the 1 s buffer loop isn't heard.
const LAYERS = [
  // Low slosh/wash body.
  { type: 'lowpass', rate: 0.93, q: 0.7, freq: [220, 420], speedFreq: 200, gain: 1.0 },
  // Mid rush of water past the wheels.
  { type: 'bandpass', rate: 1.07, q: 0.8, freq: [600, 1100], speedFreq: 900, gain: 0.55 },
  // Spray hiss, mostly at speed.
  { type: 'highpass', rate: 1.21, q: 0.5, freq: [2600, 3400], speedFreq: 0, gain: 0.18, speedOnly: true },
];
const WANDER_INTERVAL_S = [0.12, 0.45];
const WANDER_GAIN = [0.55, 1];

const rand = ([min, max]) => min + Math.random() * (max - min);

export function createWaterWadeSound() {
  let voices = null;

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
      filter.frequency.value = layer.freq[0];
      gain.gain.value = 0;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(out);
      source.start(0, Math.random() * noise.duration);
      return { layer, filter, gain, nextWander: 0, freq: layer.freq[0], wobble: 1 };
    });
  }

  /**
   * @param {number} wetFraction - share of wheels on water, 0..1.
   * @param {number} speed - chassis speed (m/s).
   */
  function update(wetFraction, speed) {
    const audio = getAudio();
    if (!audio) return;
    const { ctx, buses, noise } = audio;
    if (!voices) {
      if (wetFraction <= 0) return; // don't start the graph until first needed
      voices = build(ctx, buses.carSfx, noise);
    }
    const now = ctx.currentTime;
    const speedFrac = Math.min(1, speed / FULL_SPEED_MPS);
    const level = wetFraction > 0 ? Math.sqrt(wetFraction) * (IDLE_LEVEL + (1 - IDLE_LEVEL) * speedFrac) : 0;

    for (const v of voices) {
      const { layer } = v;
      if (now >= v.nextWander) {
        v.nextWander = now + rand(WANDER_INTERVAL_S);
        v.freq = rand(layer.freq);
        v.wobble = rand(WANDER_GAIN);
        v.filter.frequency.setTargetAtTime(v.freq + layer.speedFreq * speedFrac, now, 0.15);
      }
      const layerLevel = layer.speedOnly ? level * speedFrac : level;
      v.gain.gain.setTargetAtTime(MAX_GAIN * layer.gain * layerLevel * v.wobble, now, FADE_S);
    }
  }

  return { update };
}
