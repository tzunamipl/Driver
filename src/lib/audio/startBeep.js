// Rally timing clock beeps: short ones for each countdown light and for checking in at a
// time / stop control, a longer higher one at GO and at the finish.

import { getAudio } from './audioContext.js';

const BEEP = { hz: 880, len: 0.16 };
const GO = { hz: 1760, len: 0.55 };
const GAIN = 0.02;

export function createStartBeep() {
  return {
    /** @param {boolean} go - the long GO / finish tone instead of a short beep. */
    play(go = false) {
      const audio = getAudio();
      if (!audio) return;
      const { ctx, buses } = audio;
      const { hz, len } = go ? GO : BEEP;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = hz;
      // Square through a lowpass: the hard-edged buzz of a timing clock, not a harsh chip tone.
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = hz * 3;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(GAIN, now + 0.008);
      g.gain.setValueAtTime(GAIN, now + len - 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, now + len);
      osc.connect(filter).connect(g).connect(buses.sfx);
      osc.start(now);
      osc.stop(now + len);
    },
  };
}
