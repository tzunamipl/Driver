// Headlight stalk click: two short band-passed noise ticks (press + detent), higher when switching on.

import { getAudio } from './audioContext.js';

const TICK_S = 0.012;
const DETENT_DELAY_S = 0.045;
const GAIN = 0.4;

export function createLightSwitchSound() {
  function tick(ctx, buses, noise, t, freq, gain) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = 4;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.001, t + TICK_S);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.connect(filter);
    filter.connect(env);
    env.connect(buses.carSfx);
    src.start(t, Math.random() * 0.9, TICK_S);
  }

  function play(on) {
    const audio = getAudio();
    if (!audio) return;
    const { ctx, buses, noise } = audio;
    const now = ctx.currentTime;
    const freq = on ? 3400 : 2600;
    tick(ctx, buses, noise, now, freq, GAIN);
    tick(ctx, buses, noise, now + DETENT_DELAY_S, freq * 0.7, GAIN * 0.5);
  }

  return { play };
}
