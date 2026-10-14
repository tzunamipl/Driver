// Body thud: a short falling triangle tone, louder with impact speed.

import { getAudio } from './audioContext.js';

const DURATION_S = 0.15;
const MAX_GAIN = 0.8;
const GAIN_PER_MPS = 1 / 15;

export function createImpactSound() {
  /** @param {number} speed - impact speed along the contact normal (m/s). */
  function play(speed) {
    const audio = getAudio();
    if (!audio) return;
    const { ctx, buses } = audio;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(100, now);
    osc.frequency.exponentialRampToValueAtTime(35, now + 0.12);
    gain.gain.setValueAtTime(Math.min(speed * GAIN_PER_MPS, MAX_GAIN), now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + DURATION_S);
    osc.connect(gain);
    gain.connect(buses.sfx);
    osc.start(now);
    osc.stop(now + DURATION_S);
  }

  return { play };
}
