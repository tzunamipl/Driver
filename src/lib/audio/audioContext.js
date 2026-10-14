// One shared AudioContext for every sound, created on first use. Browsers
// keep it suspended until a user gesture, so the first key/tap resumes it.
// Graph: each sound -> bus (music | sfx | engine) -> master -> speakers.

const BUS_NAMES = ['music', 'sfx', 'engine'];

let audio = null;

export function getAudio() {
  if (audio) return audio;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  const ctx = new AudioCtx();
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const buses = {};
  for (const name of BUS_NAMES) {
    buses[name] = ctx.createGain();
    buses[name].connect(master);
  }
  audio = { ctx, master, buses, noise: whiteNoise(ctx) };

  const unlock = () => {
    if (ctx.state === 'suspended') ctx.resume();
  };
  window.addEventListener('keydown', unlock);
  window.addEventListener('pointerdown', unlock);
  return audio;
}

/** Sets a bus ('music' | 'sfx' | 'engine') or 'master' volume, 0..1. */
export function setVolume(name, value) {
  const a = getAudio();
  if (!a) return;
  const node = name === 'master' ? a.master : a.buses[name];
  if (node) node.gain.value = Math.min(1, Math.max(0, value));
}

// One second of white noise, looped or sliced by noise-based sounds.
function whiteNoise(ctx) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
