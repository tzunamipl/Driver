// Water splash: a short burst of lowpassed noise, louder with speed.

import { getAudio } from './audioContext.js';

const MIN_INTERVAL_S = 0.2; // several wheels splash at once; play one
const DURATION_S = 0.65;
const ATTACK_S = 0.05;
const MAX_GAIN = 0.1;
const GAIN_PER_MPS = 0.02;

export function createWaterSplashSound() {
  let lastPlayed = -Infinity;

  /** @param {number} speed - chassis speed (m/s). */
  function play(speed) {
    const audio = getAudio();
    if (!audio) return;
    const { ctx, buses, noise } = audio;
    const now = ctx.currentTime;
    if (now - lastPlayed < MIN_INTERVAL_S) return;
    lastPlayed = now;

    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    source.buffer = noise;
    // Random offset into the shared buffer so repeats don't sound identical.
    const offset = Math.random() * (noise.duration - DURATION_S);
    filter.type = 'lowpass';
    filter.frequency.value = 600 + Math.random() * 200;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(buses.sfx);

    const peak = Math.min(MAX_GAIN, speed * GAIN_PER_MPS);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peak, now + ATTACK_S);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + DURATION_S);
    source.start(now, offset);
    source.stop(now + DURATION_S);
  }

  return { play };
}
