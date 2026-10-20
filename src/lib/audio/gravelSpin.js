// Loose-ground tyre slide/wheelspin: a gritty crunch of band-passed noise
// whose amplitude is shaken by a low-passed noise envelope (stones scattering),
// plus a thin spatter hiss that grows with slip speed.

import { getAudio } from './audioContext.js';

// Surfaces that crunch; road/rock/builtUp squeal (tireSqueal.js), water wades.
export const GRAVEL_SURFACES = new Set(['unpaved', 'normal', 'forest', 'scrub', 'sand']);

const MAX_GAIN = 0.04;
const SLIP_FOR_MAX_MPS = 8; // slip speed at which a wheel reaches full level
const MIN_WHEEL_LEVEL = 0.35; // any sliding wheel is clearly audible
const GRAIN_HZ = 45; // crunch envelope bandwidth: lower = coarser stones
const GRAIN_DEPTH = 0.9;
const FADE_S = 0.06;

const LAYERS = [
  // Crunch body.
  { type: 'bandpass', rate: 0.8, q: 0.9, freq: 650, slipFreq: 500, gain: 1.0 },
  // Stone spatter hiss.
  { type: 'highpass', rate: 1.13, q: 0.6, freq: 3200, slipFreq: 1200, gain: 0.3, slipOnly: true },
];

export function createGravelSpinSound() {
  let voices = null;

  function build(ctx, out, noise) {
    // Shared crunch envelope: slow noise driving the grain gain's AudioParam.
    const grain = ctx.createGain();
    grain.gain.value = 1 - GRAIN_DEPTH;
    grain.connect(out);
    const envSource = ctx.createBufferSource();
    envSource.buffer = noise;
    envSource.loop = true;
    const envFilter = ctx.createBiquadFilter();
    envFilter.type = 'lowpass';
    envFilter.frequency.value = GRAIN_HZ;
    const envDepth = ctx.createGain();
    envDepth.gain.value = GRAIN_DEPTH * 20; // white noise low-passed this far is ~25x quieter
    envSource.connect(envFilter);
    envFilter.connect(envDepth);
    envDepth.connect(grain.gain);
    envSource.start(0, Math.random() * noise.duration);

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
      gain.connect(grain);
      source.start(0, Math.random() * noise.duration);
      return { layer, filter, gain };
    });
  }

  /** @param {object|null} vehicle - wheeledVehicle.js vehicle, or null. */
  function update(vehicle) {
    let level = 0;
    let slip = 0;
    for (const w of vehicle?.wheelInfos ?? []) {
      if (!w.sliding || !GRAVEL_SURFACES.has(w.surface)) continue;
      const wheelSlip = Math.hypot(w.spinSlipSpeed ?? 0, w.sideSlipSpeed ?? 0);
      const frac = Math.min(1, wheelSlip / SLIP_FOR_MAX_MPS);
      level += MIN_WHEEL_LEVEL + (1 - MIN_WHEEL_LEVEL) * frac;
      slip = Math.max(slip, frac);
    }
    level = Math.min(1, level / 2); // two sliding wheels = full

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
      v.filter.frequency.setTargetAtTime(layer.freq + layer.slipFreq * slip, now, 0.05);
      const layerLevel = layer.slipOnly ? level * slip : level;
      v.gain.gain.setTargetAtTime(MAX_GAIN * layer.gain * layerLevel, now, FADE_S);
    }
  }

  return { update };
}
