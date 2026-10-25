// Impact wrench for a repair: two "brrrt" bursts - a buzzy tone chopped
// into rapid hammer blows.

import { getAudio } from './audioContext.js';

const GAIN = 0.1;
// Loosen (spins up), then a short final hit (winds down): length and start / end pitch.
const BURSTS = [
  { len: 0.4, hz: [170, 250] },
  { len: 0.25, hz: [250, 150] },
];
const GAP_S = 0.12;
const BLOWS_PER_S = 28;
const TONE_HZ = 2500;

function burst(ctx, out, at, { len, hz }) {
  const end = at + len;
  const buzz = ctx.createOscillator();
  buzz.type = 'sawtooth';
  buzz.frequency.setValueAtTime(hz[0], at);
  buzz.frequency.exponentialRampToValueAtTime(hz[1], end);
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = TONE_HZ;

  // Square LFO fully chops the buzz: each high half is one blow.
  const chop = ctx.createGain();
  chop.gain.value = 0.5;
  const lfo = ctx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = BLOWS_PER_S;
  const depth = ctx.createGain();
  depth.gain.value = 0.5;
  lfo.connect(depth).connect(chop.gain);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(GAIN, at + 0.01);
  env.gain.setValueAtTime(GAIN, end - 0.03);
  env.gain.linearRampToValueAtTime(0, end);

  buzz.connect(tone).connect(chop).connect(env).connect(out);
  for (const osc of [buzz, lfo]) {
    osc.start(at);
    osc.stop(end);
  }
}

export function createRepairTool() {
  return {
    play() {
      const audio = getAudio();
      if (!audio) return;
      const { ctx, buses } = audio;
      let at = ctx.currentTime;
      for (const b of BURSTS) {
        burst(ctx, buses.carSfx, at, b);
        at += b.len + GAP_S;
      }
    },
  };
}
