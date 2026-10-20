// Body scraping along the ground while the car lies on its side or roof:
// a low grinding rumble plus a few narrow, inharmonic resonances (sheet metal)
// over noise, louder and brighter with sliding speed. Fed by app/carManager.js's
// chassis ground-contact events; fades out once contacts stop.

import { getAudio } from './audioContext.js';

const MAX_GAIN = 0.0875;
const MIN_SPEED_MPS = 0.6; // below this the body is resting, not sliding
const FULL_SPEED_MPS = 12;
const MAX_UP_Y = 0.5; // body up-axis y below this = on its side/roof (>60 deg tilt)
const CONTACT_HOLD_S = 0.12; // contacts flicker step to step; hold the level across gaps
const FADE_S = 0.05;

const LAYERS = [
  // Grinding rumble.
  { type: 'lowpass', rate: 0.7, q: 0.8, freq: 260, speedFreq: 300, gain: 1.0 },
  // Metal resonances.
  { type: 'bandpass', rate: 1.0, q: 14, freq: 1730, speedFreq: 250, gain: 1.6 },
  { type: 'bandpass', rate: 1.09, q: 18, freq: 2870, speedFreq: 400, gain: 1.2 },
  // Rasp, mostly at speed.
  { type: 'highpass', rate: 1.23, q: 0.5, freq: 4200, speedFreq: 0, gain: 0.25, speedOnly: true },
];
const WANDER = 0.12; // random +/- share of each resonance's frequency, re-rolled per frame

export function createBodyScrapeSound() {
  let voices = null;
  let holdTimer = 0;
  let speed = 0;

  function build(ctx, out, noise) {
    return LAYERS.map((layer) => {
      const source = ctx.createBufferSource();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      source.buffer = noise;
      source.loop = true;
      source.playbackRate.value = layer.rate;
      filter.type = layer.type;
      filter.Q.value = layer.q;
      filter.frequency.value = layer.freq;
      gain.gain.value = 0;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(out);
      source.start(0, Math.random() * noise.duration);
      return { layer, filter, gain };
    });
  }

  /**
   * Chassis touching the ground this physics step.
   * @param {import('cannon-es').Body} body
   */
  function onGroundContact(body) {
    // Body up axis (local +y) in world space: y component only.
    const q = body.quaternion;
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    if (upY > MAX_UP_Y) return;
    holdTimer = CONTACT_HOLD_S;
    speed = Math.max(speed, body.velocity.length());
  }

  /** @param {number} dt - frame delta in seconds. */
  function update(dt) {
    holdTimer -= dt;
    const scraping = holdTimer > 0 && speed > MIN_SPEED_MPS;
    const speedFrac = scraping ? Math.min(1, (speed - MIN_SPEED_MPS) / (FULL_SPEED_MPS - MIN_SPEED_MPS)) : 0;
    const level = scraping ? 0.25 + 0.75 * speedFrac : 0;
    if (holdTimer <= 0) speed = 0;

    const audio = getAudio();
    if (!audio) return;
    const { ctx, buses, noise } = audio;
    if (!voices) {
      if (level <= 0) return; // don't start the graph until first needed
      voices = build(ctx, buses.carSfx, noise);
    }
    const now = ctx.currentTime;
    for (const v of voices) {
      const { layer } = v;
      const wander = layer.type === 'bandpass' ? 1 + (Math.random() - 0.5) * 2 * WANDER : 1;
      v.filter.frequency.setTargetAtTime((layer.freq + layer.speedFreq * speedFrac) * wander, now, 0.03);
      const jitter = 0.7 + 0.3 * Math.random(); // uneven ground contact
      const layerLevel = layer.speedOnly ? level * speedFrac : level;
      v.gain.gain.setTargetAtTime(MAX_GAIN * layer.gain * layerLevel * jitter, now, FADE_S);
    }
  }

  return { update, onGroundContact };
}
