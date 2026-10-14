// Handbrake ratchet "trrrt": a quick run of filtered noise clicks, one per pawl tooth.

import { getAudio } from './audioContext.js';

const CLICKS = 9;
const CLICK_SPACING_S = 0.022;
const CLICK_S = 0.012;
const GAIN = 0.35;

export function createHandbrakeSound() {
  /** Full pull; `clicks` shortens it (e.g. the last notch when latching). */
  function play(clicks = CLICKS) {
    const audio = getAudio();
    if (!audio) return;
    const { ctx, buses, noise } = audio;
    const now = ctx.currentTime;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2600;
    filter.Q.value = 3;
    filter.connect(buses.sfx);
    for (let i = 0; i < clicks; i++) {
      // Teeth get closer as the lever tightens.
      const t = now + i * CLICK_SPACING_S * (1 - i / (clicks * 3));
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(GAIN, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + CLICK_S);
      src.connect(gain);
      gain.connect(filter);
      src.start(t, Math.random() * 0.9, CLICK_S);
    }
  }

  return { play };
}
