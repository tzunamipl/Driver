// Engine sound built from exhaust pulses. One oscillator period = one
// four-stroke cycle (720 deg crank) holding a pulse per cylinder, so pitch
// tracks rpm exactly. Pulse timing/strength per profile sets the character
// (paired pulses burble, even ones buzz).
// Profile from the descriptor's `engineSound`, else by its `engine` type.

import { getAudio } from './audioContext.js';
import { DEFAULT_ENGINE_SOUND, ENGINE_SOUNDS } from './engineProfiles.js';

const MASTER_GAIN = 0.032;
const FALLBACK_IDLE_RPM = 900; // hover rigs have no engine.js state
const FALLBACK_REDLINE_RPM = 6500;
const WAVE_SAMPLES = 2048;
const WAVE_HARMONICS = 96;
const BOV_MIN_RPM_FRAC = 0.45;
// Simulated turbo: blow-off only with real boost to dump (fraction of max boost).
const BOV_MIN_BOOST_FRAC = 0.3;
// Simulated turbo whizz: shaft speed (0..1) follows boost up, coasts down slowly
// after a lift; audible only above WHIZZ_FROM_SPIN, a narrow noise band that rises with it.
const SPIN_UP_TAU_S = 0.3;
const SPIN_DOWN_TAU_S = 1.5;
const WHIZZ_FROM_SPIN = 0.5;
const WHIZZ_GAIN = 0.03;
const WHIZZ_HZ_MIN = 3500;
const WHIZZ_HZ_MAX = 9000;
const CLATTER_DECAY = 0.004; // cycle fractions: near-instant injector knock
const CLATTER_HZ = 2600;
// Exhaust gone (lib/exhaustDamage.js): louder, harder into the clipper, unmuffled highs, more hiss.
const BLOWN = { gain: 1.8, drive: 1.7, brightness: 2.2, hiss: 3 };
const UNBLOWN = { gain: 1, drive: 1, brightness: 1, hiss: 1 };

// Optional profile tuning (profile.x ?? DEFAULT_X).
const DEFAULT_BANK_MIX = 0.5;
const DEFAULT_BANK_DETUNE = 1.004; // slight beat between the two exhaust paths
const DEFAULT_BODY = 1;
const DEFAULT_BRIGHTNESS = 1; // lowpass cutoff scale
const DEFAULT_HISS = 1;
const DEFAULT_CLATTER = 0; // diesel knock level
const DEFAULT_WHISTLE_PITCH = 1;

// PeriodicWaves per profile; built once.
const waves = new WeakMap();
const clatterWaves = new WeakMap();

function pulseWave(ctx, profile) {
  let wave = waves.get(profile);
  if (wave) return wave;
  wave = buildWave(ctx, profile.pulseOffsets, profile.pulseAmps, profile.pulseDecay, profile.pulseRing);
  waves.set(profile, wave);
  return wave;
}

// Spike per firing event (no ring), used as an envelope for clatter noise.
function clatterWave(ctx, profile) {
  let wave = clatterWaves.get(profile);
  if (wave) return wave;
  wave = buildWave(ctx, profile.pulseOffsets, profile.pulseAmps, CLATTER_DECAY, Infinity);
  clatterWaves.set(profile, wave);
  return wave;
}

function buildWave(ctx, pulseOffsets, pulseAmps, pulseDecay, pulseRing) {
  const cylinders = pulseOffsets.length;
  const samples = new Float32Array(WAVE_SAMPLES);
  for (let c = 0; c < cylinders; c++) {
    const start = c / cylinders + pulseOffsets[c];
    for (let n = 0; n < WAVE_SAMPLES; n++) {
      // Phase since this pulse fired, wrapped into the cycle.
      const u = (((n / WAVE_SAMPLES - start) % 1) + 1) % 1;
      samples[n] += pulseAmps[c] * Math.exp(-u / pulseDecay) * Math.cos((2 * Math.PI * u) / pulseRing);
    }
  }
  const real = new Float32Array(WAVE_HARMONICS);
  const imag = new Float32Array(WAVE_HARMONICS);
  for (let k = 1; k < WAVE_HARMONICS; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < WAVE_SAMPLES; n++) {
      const a = (2 * Math.PI * k * n) / WAVE_SAMPLES;
      re += samples[n] * Math.cos(a);
      im += samples[n] * Math.sin(a);
    }
    real[k] = (2 * re) / WAVE_SAMPLES;
    imag[k] = (2 * im) / WAVE_SAMPLES;
  }
  return ctx.createPeriodicWave(real, imag);
}

function softClipCurve(drive) {
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}

export function createEngineSound() {
  const audio = getAudio();
  if (!audio) return { update() {} };
  const { ctx, buses, noise } = audio;

  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(buses.carEngine);

  // Exhaust: two pulse oscillators -> soft clip -> lowpass (opens with rpm/load).
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.Q.value = 1.2;
  lowpass.connect(out);
  const shaper = ctx.createWaveShaper();
  shaper.curve = softClipCurve(2.5);
  shaper.oversample = '2x';
  shaper.connect(lowpass);
  const bodyGain = ctx.createGain();
  bodyGain.connect(shaper);
  const bankA = ctx.createOscillator();
  const bankB = ctx.createOscillator();
  const bankBGain = ctx.createGain();
  bankA.connect(bodyGain);
  bankB.connect(bankBGain);
  bankBGain.connect(bodyGain);

  // Exhaust hiss under load.
  const hiss = ctx.createBufferSource();
  hiss.buffer = noise;
  hiss.loop = true;
  const hissFilter = ctx.createBiquadFilter();
  hissFilter.type = 'bandpass';
  hissFilter.Q.value = 0.8;
  const hissGain = ctx.createGain();
  hissGain.gain.value = 0;
  hiss.connect(hissFilter);
  hissFilter.connect(hissGain);
  hissGain.connect(out);

  // Diesel clatter: bandpassed noise gated by a spike per firing event.
  // The spike wave is zero-mean, so the gain gets a small positive base.
  const clatterFilter = ctx.createBiquadFilter();
  clatterFilter.type = 'bandpass';
  clatterFilter.frequency.value = CLATTER_HZ;
  clatterFilter.Q.value = 1.4;
  const clatterGain = ctx.createGain();
  clatterGain.gain.value = 0;
  const clatterEnv = ctx.createOscillator();
  const clatterDepth = ctx.createGain();
  clatterDepth.gain.value = 0;
  hiss.connect(clatterFilter);
  clatterFilter.connect(clatterGain);
  clatterGain.connect(out);
  clatterEnv.connect(clatterDepth);
  clatterDepth.connect(clatterGain.gain);

  // Turbo whistle.
  const whistle = ctx.createOscillator();
  whistle.type = 'sine';
  const whistleGain = ctx.createGain();
  whistleGain.gain.value = 0;
  whistle.connect(whistleGain);
  whistleGain.connect(out);

  // Turbo whizz: own noise loop (offset from the hiss so they don't correlate).
  const whizz = ctx.createBufferSource();
  whizz.buffer = noise;
  whizz.loop = true;
  const whizzFilter = ctx.createBiquadFilter();
  whizzFilter.type = 'bandpass';
  whizzFilter.Q.value = 7;
  const whizzGain = ctx.createGain();
  whizzGain.gain.value = 0;
  whizz.connect(whizzFilter);
  whizzFilter.connect(whizzGain);
  whizzGain.connect(out);

  bankA.start();
  bankB.start();
  hiss.start();
  whistle.start();
  whizz.start(0, noise.duration / 2);
  clatterEnv.start();

  let profile = null;
  let lastThrottle = 0;
  let spin = 0; // turbo shaft speed, 0..1
  let lastTime = ctx.currentTime;

  function setProfile(next) {
    if (next === profile) return;
    profile = next;
    const wave = pulseWave(ctx, profile);
    bankA.setPeriodicWave(wave);
    bankB.setPeriodicWave(wave);
    bankBGain.gain.value = profile.bankMix ?? DEFAULT_BANK_MIX;
    clatterEnv.setPeriodicWave(clatterWave(ctx, profile));
  }

  function blowOff(now) {
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = noise;
    filter.type = 'bandpass';
    filter.Q.value = 1.5;
    filter.frequency.setValueAtTime(3200, now);
    filter.frequency.exponentialRampToValueAtTime(1400, now + 0.35);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(out);
    src.start(now, Math.random() * 0.5);
    src.stop(now + 0.42);
  }

  /**
   * @param {object|null} vehicle - silent when null.
   * @param {object|null} descriptor - vehicles/ descriptor (engineSound or engine).
   * @param {number} throttle - 0..1.
   */
  function update(vehicle, descriptor, throttle) {
    setProfile(descriptor?.engineSound ?? ENGINE_SOUNDS[descriptor?.engine] ?? DEFAULT_ENGINE_SOUND);
    const now = ctx.currentTime;
    const engine = vehicle?.engine;
    const idle = engine?.idleRpm ?? FALLBACK_IDLE_RPM;
    const redline = engine?.redlineRpm ?? FALLBACK_REDLINE_RPM;
    const rpm = engine?.rpm ?? idle;
    const r = Math.max(0, Math.min(1, (rpm - idle) / (redline - idle)));

    // Lope fades out as revs rise.
    const lope = 1 + (Math.random() - 0.5) * 2 * profile.idleLope * (1 - r);
    const cycleHz = (rpm / 120) * lope;
    bankA.frequency.setTargetAtTime(cycleHz, now, 0.03);
    bankB.frequency.setTargetAtTime(cycleHz * (profile.bankDetune ?? DEFAULT_BANK_DETUNE), now, 0.03);
    clatterEnv.frequency.setTargetAtTime(cycleHz, now, 0.03);

    const blown = vehicle?.exhaust?.detached ? BLOWN : UNBLOWN;
    out.gain.setTargetAtTime(vehicle ? MASTER_GAIN * blown.gain : 0, now, 0.1);
    const body = (profile.body ?? DEFAULT_BODY) * blown.drive;
    bodyGain.gain.setTargetAtTime(body * (0.5 + 0.4 * throttle + 0.3 * r), now, 0.08);
    const brightness = (profile.brightness ?? DEFAULT_BRIGHTNESS) * blown.brightness;
    lowpass.frequency.setTargetAtTime(brightness * (220 + r * 1600 + throttle * (300 + r * 900)), now, 0.08);

    const firingHz = (rpm / 120) * profile.pulseOffsets.length;
    const hissLevel = (profile.hiss ?? DEFAULT_HISS) * blown.hiss;
    hissFilter.frequency.setTargetAtTime(firingHz * 6, now, 0.05);
    hissGain.gain.setTargetAtTime(hissLevel * (0.01 + throttle * (0.02 + 0.08 * r)), now, 0.08);

    // Knock is loudest at idle and under load, smoothing out at high revs.
    const clatter = (profile.clatter ?? DEFAULT_CLATTER) * (0.25 + 0.2 * throttle) * (1 - 0.5 * r);
    clatterDepth.gain.setTargetAtTime(clatter, now, 0.08);
    clatterGain.gain.setTargetAtTime(clatter * 0.2, now, 0.08);

    // Engines with a simulated turbo whistle with their real boost; the rest fake it from load.
    const simulated = !!engine?.turbo;
    const boost = simulated ? engine.boostFraction : profile.turbo ? throttle * r * r : 0;
    const whistlePitch = profile.whistlePitch ?? DEFAULT_WHISTLE_PITCH;
    whistle.frequency.setTargetAtTime(whistlePitch * (1600 + (simulated ? boost : r) * 4200), now, 0.2);
    whistleGain.gain.setTargetAtTime(boost * 0.012, now, 0.3);

    const dt = Math.min(0.1, now - lastTime);
    lastTime = now;
    const spinTarget = simulated ? boost : 0;
    spin += (spinTarget - spin) * Math.min(1, dt / (spinTarget > spin ? SPIN_UP_TAU_S : SPIN_DOWN_TAU_S));
    const whizzLevel = Math.max(0, (spin - WHIZZ_FROM_SPIN) / (1 - WHIZZ_FROM_SPIN));
    whizzFilter.frequency.setTargetAtTime(whistlePitch * (WHIZZ_HZ_MIN + (WHIZZ_HZ_MAX - WHIZZ_HZ_MIN) * spin), now, 0.1);
    whizzGain.gain.setTargetAtTime(whizzLevel * whizzLevel * WHIZZ_GAIN, now, 0.1);

    const hasBlowOff = profile.blowOff ?? (simulated || profile.turbo);
    const pressurised = simulated ? boost > BOV_MIN_BOOST_FRAC : r > BOV_MIN_RPM_FRAC;
    if (hasBlowOff && vehicle && lastThrottle > 0.5 && throttle < 0.5 && pressurised) blowOff(now);
    lastThrottle = throttle;
  }

  return { update };
}
