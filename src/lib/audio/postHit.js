// Roadside object knocked over: a light, high plastic knock on the shared thud
// voice, or for metal kinds (lamps, signs) a dull thud under a ringing clang.

import { getAudio } from './audioContext.js';
import { playThud } from './impact.js';

const SPEED_FOR_MAX = 200; // m/s
const MIN_LEVEL = 0.05;
const COOLDOWN_S = 0.05; // a row of posts in one swipe still reads as separate knocks
// Clang: inharmonic partials of a free bar (ratios of its bending modes) read as metal, not a tone.
const CLANG_PARTIALS = [
  { ratio: 1, gain: 1, decay: 0.9 },
  { ratio: 2.76, gain: 0.6, decay: 0.55 },
  { ratio: 5.4, gain: 0.35, decay: 0.3 },
  { ratio: 8.93, gain: 0.2, decay: 0.18 },
];
const CLANG_BASE_HZ = 520; // at REF_MASS
const CLANG_REF_MASS = 4; // kg
const CLANG_GAIN = 0.35;
/** Hit sound volume (kind `hitGain`) for sign boards: thin sheet, quieter than lamps and rails. */
export const SIGN_HIT_GAIN = 0.4;

function playClang(level, mass, volume) {
  const audio = getAudio();
  if (!audio) return;
  const { ctx, buses, noise } = audio;
  const now = ctx.currentTime;
  const out = ctx.createGain();
  out.gain.value = volume * CLANG_GAIN * (0.4 + 0.6 * level);
  out.connect(buses.carSfx);
  // Heavier boards ring lower; random detune so a row of hits doesn't repeat one note.
  const base = CLANG_BASE_HZ * (CLANG_REF_MASS / mass) ** 0.3 * (0.92 + Math.random() * 0.16);
  const length = 0.6 + 0.6 * level;
  for (const { ratio, gain, decay } of CLANG_PARTIALS) {
    const len = decay * length;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = base * ratio * (0.99 + Math.random() * 0.02);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain, now + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, now + len);
    osc.connect(g).connect(out);
    osc.start(now);
    osc.stop(now + len);
  }
  // Strike: short bright noise tick for the hard contact.
  const tickLen = 0.04;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = base * 6;
  filter.Q.value = 1.5;
  const tickGain = ctx.createGain();
  tickGain.gain.setValueAtTime(0.8, now);
  tickGain.gain.exponentialRampToValueAtTime(0.001, now + tickLen);
  src.connect(filter).connect(tickGain).connect(out);
  src.start(now, Math.random() * 0.5);
  src.stop(now + tickLen);
}

export function createPostHitSound() {
  let lastAt = 0;
  return {
    play(speed, kind) {
      const now = performance.now() / 1000;
      if (now - lastAt < COOLDOWN_S) return;
      lastAt = now;
      const level = MIN_LEVEL + (1 - MIN_LEVEL) * Math.min(1, speed / SPEED_FOR_MAX);
      const volume = kind?.hitGain ?? 1;
      if (kind?.hitSound === 'metal') {
        playThud(level, { gain: volume * (0.4 + 0.4 * level), pitch: 1.4, crunch: 0.4, length: 0.4, knock: 1 });
        playClang(level, kind.mass ?? CLANG_REF_MASS, volume);
        return;
      }
      playThud(level, { gain: volume * (0.5 + 0.5 * level), pitch: 2.4, crunch: 0.6, length: 0.35, knock: 1.2 });
    },
  };
}
