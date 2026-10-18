// Road post knocked over: a light, high plastic knock on the shared thud voice.

import { playThud } from './impact.js';

const SPEED_FOR_MAX = 200; // m/s
const MIN_LEVEL = 0.05;
const COOLDOWN_S = 0.05; // a row of posts in one swipe still reads as separate knocks

export function createPostHitSound() {
  let lastAt = 0;
  return {
    play(speed) {
      const now = performance.now() / 1000;
      if (now - lastAt < COOLDOWN_S) return;
      lastAt = now;
      const level = MIN_LEVEL + (1 - MIN_LEVEL) * Math.min(1, speed / SPEED_FOR_MAX);
      playThud(level, { gain: 0.5 + 0.5 * level, pitch: 2.4, crunch: 0.6, length: 0.35, knock: 1.2 });
    },
  };
}
