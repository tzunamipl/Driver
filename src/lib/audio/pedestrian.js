// Cartoon pedestrian voices: a sawtooth "throat" through two sweeping
// formant band-passes, so the vowel glides ("waaah", "oof", "hey!").
// Hits play at the car; bounces and near-miss gasps fade with camera distance.

import { getAudio } from './audioContext.js';
import { playThud } from './impact.js';

const FULL_DISTANCE_M = 12;
const SILENT_DISTANCE_M = 110;
const VOICE_GAIN = 0.03;
const SCREAM_SPEED = 4; // m/s; slower taps get an "oof" instead of a scream
const BOUNCE_MIN_SPEED = 1.5;
const BOUNCE_SPEED_FOR_MAX = 9;
const BASE_PITCH_MIN = 170;
const BASE_PITCH_MAX = 330;

// [F1, F2] in Hz.
const VOWEL = {
  u: [320, 800],
  o: [500, 900],
  a: [760, 1150],
  e: [530, 1850],
  i: [300, 2300],
};

/** Stable per-figure pitch, so the same pedestrian always sounds the same. */
function basePitchOf(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const t = (h >>> 0) / 4294967296;
  return BASE_PITCH_MIN + (BASE_PITCH_MAX - BASE_PITCH_MIN) * t;
}

function distanceGain(distance) {
  const t = (distance - FULL_DISTANCE_M) / (SILENT_DISTANCE_M - FULL_DISTANCE_M);
  const g = Math.min(1, Math.max(0, 1 - t));
  return g * g;
}

/**
 * One vocal gesture. `pitch` is [[timeFraction, multiplier], ...] over the
 * base pitch, `vowels` the vowel at each of the same kind of time stops.
 */
function voice(destination, { base, duration, gain, pitch, vowels, breath = 0, vibrato = 0.03 }) {
  const audio = getAudio();
  if (!audio) return;
  const { ctx, noise } = audio;
  const now = ctx.currentTime;
  const end = now + duration;

  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, now);
  out.gain.exponentialRampToValueAtTime(gain, now + 0.02);
  out.gain.setValueAtTime(gain, end - Math.min(0.12, duration * 0.4));
  out.gain.exponentialRampToValueAtTime(0.0001, end);
  out.connect(destination);

  const throat = ctx.createGain();
  throat.gain.value = 0.5;
  const oscs = [1, 1.006].map((detune) => {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    pitch.forEach(([t, m], i) => {
      const f = base * m * detune;
      if (i === 0) osc.frequency.setValueAtTime(f, now);
      else osc.frequency.exponentialRampToValueAtTime(f, now + t * duration);
    });
    osc.connect(throat);
    return osc;
  });
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 6 + Math.random() * 2;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = base * vibrato;
  lfo.connect(lfoDepth);
  for (const osc of oscs) lfoDepth.connect(osc.frequency);

  // Formants in parallel; F2 quieter, as in real voices.
  [[0, 1, 7], [1, 0.55, 10]].forEach(([formant, level, q]) => {
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = q;
    vowels.forEach(([t, v], i) => {
      const f = VOWEL[v][formant];
      if (i === 0) filter.frequency.setValueAtTime(f, now);
      else filter.frequency.linearRampToValueAtTime(f, now + t * duration);
    });
    const g = ctx.createGain();
    g.gain.value = level * 4;
    throat.connect(filter).connect(g).connect(out);
  });

  // Breathy onset ("h" of "hey").
  if (breath > 0) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 1500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(breath, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
    src.connect(filter).connect(g).connect(out);
    src.start(now, Math.random() * 0.5);
    src.stop(now + 0.08);
  }

  for (const node of [...oscs, lfo]) {
    node.start(now);
    node.stop(end + 0.02);
  }
}

export function createPedestrianSounds() {
  /** A figure hit by the own car; plays at the car. `speed` = car speed (m/s). */
  function hit(id, speed) {
    const audio = getAudio();
    if (!audio) return;
    const destination = audio.buses.carSfx;
    const level = Math.min(1, speed / 25);
    playThud(level, { gain: 0.6 + 1.2 * level, pitch: 0.6, crunch: 0.5, length: 0.8 });
    const base = basePitchOf(id);
    if (speed < SCREAM_SPEED) {
      voice(destination, {
        base, duration: 0.2, gain: VOICE_GAIN,
        pitch: [[0, 1.25], [1, 0.8]],
        vowels: [[0, 'u'], [1, 'o']],
      });
      return;
    }
    // "Waaah!": jumps up, wobbles, falls off as the figure flies away.
    voice(destination, {
      base, duration: 0.55 + 0.5 * level, gain: VOICE_GAIN * (1 + 0.4 * level),
      pitch: [[0, 1.4], [0.15, 2.1], [0.6, 1.8], [1, 0.9]],
      vowels: [[0, 'u'], [0.2, 'a'], [1, 'a']],
      vibrato: 0.06,
    });
  }

  /** Ragdoll hitting ground or a wall. `distance` from the camera (m). */
  function bounce(id, speed, distance) {
    if (speed < BOUNCE_MIN_SPEED) return;
    const audio = getAudio();
    const near = distanceGain(distance);
    if (!audio || near <= 0) return;
    const level = Math.min(1, (speed - BOUNCE_MIN_SPEED) / (BOUNCE_SPEED_FOR_MAX - BOUNCE_MIN_SPEED));
    const destination = audio.buses.sfx;
    playThud(level, { gain: (0.06 + 0.18 * level) * near, pitch: 1.3, crunch: 0.35, length: 0.55, destination });
    if (level > 0.35 && Math.random() < 0.5) {
      voice(destination, {
        base: basePitchOf(id), duration: 0.14, gain: VOICE_GAIN * 0.7 * near,
        pitch: [[0, 1.1], [1, 0.75]],
        vowels: [[0, 'o'], [1, 'u']],
      });
    }
  }

  /** Standing figure gasping after a car just missed it. */
  function gasp(id, distance) {
    const audio = getAudio();
    const near = distanceGain(distance);
    if (!audio || near <= 0) return;
    const destination = audio.buses.sfx;
    const base = basePitchOf(id);
    if (Math.random() < 0.5) {
      // Sharp breathy "hhah!" rising in pitch.
      voice(destination, {
        base, duration: 0.24, gain: VOICE_GAIN * 0.8 * near, breath: 0.9,
        pitch: [[0, 1.3], [1, 1.75]],
        vowels: [[0, 'a'], [1, 'o']],
        vibrato: 0.01,
      });
    } else {
      // Startled "ooh!" sliding up then down.
      voice(destination, {
        base, duration: 0.4, gain: VOICE_GAIN * near, breath: 0.4,
        pitch: [[0, 1.2], [0.35, 1.7], [1, 1.15]],
        vowels: [[0, 'u'], [0.4, 'o'], [1, 'u']],
      });
    }
  }

  return { hit, bounce, gasp };
}
