// Coolant leak hiss: a soft "sssss" of high bandpassed noise, louder with the
// leak, with a slow random flutter so it sounds like escaping steam. Local car (carSfx).

import { getAudio } from './audioContext.js';

const MAX_GAIN = 0.015;
const BASE_LEVEL = 0.35; // share of full level at the slowest seep
const FREQ_HZ = [4200, 6500]; // wanders inside; higher with the leak
const Q = 1.2;
const WANDER_INTERVAL_S = [0.08, 0.3];
const WANDER_GAIN = [0.6, 1];
const FADE_S = 0.1;

const rand = ([min, max]) => min + Math.random() * (max - min);

export function createCoolantHissSound() {
  let voice = null;
  let nextWander = 0;
  let wobble = 1;

  function build(ctx, out, noise) {
    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    source.buffer = noise;
    source.loop = true;
    source.playbackRate.value = 1.13;
    filter.type = 'bandpass';
    filter.Q.value = Q;
    filter.frequency.value = FREQ_HZ[0];
    gain.gain.value = 0;
    source.connect(filter).connect(gain).connect(out);
    source.start(0, Math.random() * noise.duration);
    return { filter, gain };
  }

  /** @param {number} intensity - leak strength 0..1 (0 = silent). */
  function update(intensity) {
    const audio = getAudio();
    if (!audio) return;
    const { ctx, buses, noise } = audio;
    if (!voice) {
      if (intensity <= 0) return; // don't start the graph until first needed
      voice = build(ctx, buses.carSfx, noise);
    }
    const now = ctx.currentTime;
    if (now >= nextWander) {
      nextWander = now + rand(WANDER_INTERVAL_S);
      wobble = rand(WANDER_GAIN);
      const top = FREQ_HZ[0] + (FREQ_HZ[1] - FREQ_HZ[0]) * intensity;
      voice.filter.frequency.setTargetAtTime(rand([FREQ_HZ[0], top]), now, 0.1);
    }
    const level = intensity > 0 ? BASE_LEVEL + (1 - BASE_LEVEL) * intensity : 0;
    voice.gain.gain.setTargetAtTime(MAX_GAIN * level * wobble, now, FADE_S);
  }

  return { update };
}
