// One shared AudioContext for every sound, created on first use. Browsers
// keep it suspended until a user gesture, so the first key/tap resumes it.
// Graph: each sound -> bus (music | sfx | engine) -> master -> speakers.
// The local car's sounds go through carSfx / carEngine first, which fade
// and pan with the car's position relative to the camera (setCarListener).
// Wheel sounds use createWheelOutput instead: their own panner per sound, so
// behind-the-car cameras can put each wheel side in its own speaker.

const BUS_NAMES = ['music', 'sfx', 'engine'];

let audio = null;
// Equal-power pan where the far speaker gets ~10% of the near one's amplitude (tan = 9).
const WHEEL_PAN = (4 / Math.PI) * Math.atan(9) - 1;
let carPan = 0;
let wheelStereo = false;
const wheelOutputs = [];
// Remembered so volumes can be set before the context exists (no early AudioContext).
const levels = { master: 1, music: 1, sfx: 1, engine: 1 };

export function getAudio() {
  if (audio) return audio;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  const ctx = new AudioCtx();
  const master = ctx.createGain();
  master.gain.value = levels.master;
  master.connect(ctx.destination);
  const buses = {};
  for (const name of BUS_NAMES) {
    buses[name] = ctx.createGain();
    buses[name].gain.value = levels[name];
    buses[name].connect(master);
  }
  const carPanners = [];
  buses.carSfx = carStage(ctx, buses.sfx, carPanners);
  buses.carEngine = carStage(ctx, buses.engine, carPanners);
  buses.carWheels = ctx.createGain();
  buses.carWheels.connect(buses.sfx);
  audio = { ctx, master, buses, carPanners, noise: whiteNoise(ctx) };

  const unlock = () => {
    if (ctx.state === 'suspended') ctx.resume();
  };
  window.addEventListener('keydown', unlock);
  window.addEventListener('pointerdown', unlock);
  return audio;
}

/** Sets a bus ('music' | 'sfx' | 'engine') or 'master' volume, 0..1. */
export function setVolume(name, value) {
  const level = Math.min(1, Math.max(0, value));
  levels[name] = level;
  if (!audio) return;
  const node = name === 'master' ? audio.master : audio.buses[name];
  if (node) node.gain.value = level;
}

/** Local car's volume (0..1) and stereo pan (-1..1), smoothed so camera switches don't click. */
export function setCarListener(gain, pan) {
  if (!audio) return;
  const t = audio.ctx.currentTime;
  audio.buses.carSfx.gain.setTargetAtTime(gain, t, 0.08);
  audio.buses.carEngine.gain.setTargetAtTime(gain, t, 0.08);
  audio.buses.carWheels.gain.setTargetAtTime(gain, t, 0.08);
  for (const panner of audio.carPanners) panner.pan.setTargetAtTime(pan, t, 0.08);
  carPan = pan;
  for (const output of wheelOutputs) output.applyPan();
}

/** Whether the camera sits behind the car facing its way, so wheel sounds pan hard by side. */
export function setWheelStereo(enabled) {
  wheelStereo = enabled;
}

/**
 * Input node for a wheel sound plus setSide(-1 left .. 1 right, car frame); null without audio.
 * Pans by side when wheel stereo is on, otherwise follows the car's pan like carSfx.
 */
export function createWheelOutput() {
  const a = getAudio();
  if (!a) return null;
  const { ctx, buses } = a;
  const input = ctx.createGain();
  if (!ctx.createStereoPanner) {
    input.connect(buses.carWheels);
    return { input, setSide() {} };
  }
  const panner = ctx.createStereoPanner();
  input.connect(panner);
  panner.connect(buses.carWheels);
  let side = 0;
  const output = {
    input,
    /** `instant` for one-shots, so the attack doesn't glide in from the last side. */
    setSide(value, instant = false) {
      side = Math.max(-1, Math.min(1, value));
      output.applyPan(instant);
    },
    applyPan(instant = false) {
      const pan = wheelStereo ? side * WHEEL_PAN : carPan;
      const t = ctx.currentTime;
      if (instant) {
        panner.pan.cancelScheduledValues(t);
        panner.pan.setValueAtTime(pan, t);
      } else {
        panner.pan.setTargetAtTime(pan, t, 0.03);
      }
    },
  };
  wheelOutputs.push(output);
  output.applyPan();
  return output;
}

// Gain -> stereo panner (where supported) -> bus; returns the gain as the stage input.
function carStage(ctx, bus, panners) {
  const gain = ctx.createGain();
  if (ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    gain.connect(panner);
    panner.connect(bus);
    panners.push(panner);
  } else {
    gain.connect(bus);
  }
  return gain;
}

// One second of white noise, looped or sliced by noise-based sounds.
function whiteNoise(ctx) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
