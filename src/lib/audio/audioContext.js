// One shared AudioContext for every sound, created on first use. Browsers
// keep it suspended until a user gesture, so the first key/tap resumes it.
// Graph: each sound -> bus (music | sfx | engine) -> master -> speakers.
// The local car's sounds go through carSfx / carEngine first, which fade
// and pan with the car's position relative to the camera (setCarListener).

const BUS_NAMES = ['music', 'sfx', 'engine'];

let audio = null;
let masterLevel = 1;

export function getAudio() {
  if (audio) return audio;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  const ctx = new AudioCtx();
  const master = ctx.createGain();
  master.gain.value = masterLevel;
  master.connect(ctx.destination);
  const buses = {};
  for (const name of BUS_NAMES) {
    buses[name] = ctx.createGain();
    buses[name].connect(master);
  }
  const carPanners = [];
  buses.carSfx = carStage(ctx, buses.sfx, carPanners);
  buses.carEngine = carStage(ctx, buses.engine, carPanners);
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
  // Master is remembered so it can be set before the context exists (no early AudioContext).
  if (name === 'master') {
    masterLevel = level;
    if (audio) audio.master.gain.value = level;
    return;
  }
  const node = getAudio()?.buses[name];
  if (node) node.gain.value = level;
}

/** Local car's volume (0..1) and stereo pan (-1..1), smoothed so camera switches don't click. */
export function setCarListener(gain, pan) {
  if (!audio) return;
  const t = audio.ctx.currentTime;
  audio.buses.carSfx.gain.setTargetAtTime(gain, t, 0.08);
  audio.buses.carEngine.gain.setTargetAtTime(gain, t, 0.08);
  for (const panner of audio.carPanners) panner.pan.setTargetAtTime(pan, t, 0.08);
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
