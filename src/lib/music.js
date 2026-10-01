// Original hardbass loop: four-on-the-floor kick and a distorted bass stab
// on the off-beat, the shape of that style. It is not a recording and not
// anyone's song. Silent until the first key or tap (autoplay policy).
// The slider sets loudness and is remembered in localStorage.

const BPM = 150;
const MAX_GAIN = 0.1;
const DEFAULT_VOLUME = 0.4;
const STORAGE_KEY = 'driver-music-volume';
const SIXTEENTH = 60 / BPM / 4;

// Two bars. 1 = a bass stab. Kicks land on every beat (step % 4 === 0).
const BASS = [
  0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0,
  0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1,
];
// Original riff, one note per beat. Not transcribed from any track.
const LEAD = [523.25, 587.33, 659.25, 587.33, 493.88, 523.25, 440, 392];

export function createMusic() {
  const slider = document.getElementById('music-volume-input');
  let volume = readVolume();
  if (slider) slider.value = String(volume);

  let ctx = null;
  let master = null;
  let noise = null;
  let curve = null;
  let nextTime = 0;
  let step = 0;
  let started = false;

  function applyGain() {
    if (master) master.gain.value = volume * MAX_GAIN;
  }

  function setVolume(next) {
    volume = clamp01(next);
    try { localStorage.setItem(STORAGE_KEY, String(volume)); } catch { /* private mode */ }
    applyGain();
  }

  slider?.addEventListener('input', () => setVolume(slider.value));

  function context() {
    if (ctx) return ctx;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    ctx = new AudioCtx();
    master = ctx.createGain();
    applyGain();
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 3200;
    master.connect(lowpass);
    lowpass.connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    curve = distortionCurve(18);
    return ctx;
  }

  function env(gain, time, peak, dur) {
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(peak, time + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  }

  function kick(time) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(170, time);
    osc.frequency.exponentialRampToValueAtTime(40, time + 0.12);
    env(gain, time, 0.9, 0.22);
    osc.connect(gain);
    gain.connect(master);
    osc.start(time);
    osc.stop(time + 0.24);
  }

  function bass(time) {
    const osc = ctx.createOscillator();
    const shaper = ctx.createWaveShaper();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(96, time);
    osc.frequency.exponentialRampToValueAtTime(42, time + 0.08);
    shaper.curve = curve;
    shaper.oversample = '4x';
    filter.type = 'lowpass';
    filter.Q.value = 10;
    filter.frequency.setValueAtTime(1600, time);
    filter.frequency.exponentialRampToValueAtTime(150, time + 0.1);
    env(gain, time, 0.8, 0.15);
    osc.connect(shaper);
    shaper.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start(time);
    osc.stop(time + 0.18);
  }

  function clap(time) {
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    src.buffer = noise;
    filter.type = 'bandpass';
    filter.frequency.value = 1800;
    filter.Q.value = 0.7;
    env(gain, time, 0.28, 0.12);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start(time);
    src.stop(time + 0.14);
  }

  function lead(time, freq) {
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    filter.type = 'lowpass';
    filter.frequency.value = 1800;
    env(gain, time, 0.09, 0.12);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start(time);
    osc.stop(time + 0.14);
  }

  function pump() {
    const audio = context();
    if (!audio) return;
    if (audio.state === 'suspended') audio.resume();
    const horizon = audio.currentTime + 0.25;
    if (nextTime < audio.currentTime) nextTime = audio.currentTime + 0.05;
    while (nextTime < horizon) {
      const i = step % BASS.length;
      if (i % 4 === 0) kick(nextTime);
      if (BASS[i]) bass(nextTime);
      if (i % 8 === 4) clap(nextTime);
      if (i % 4 === 0) lead(nextTime, LEAD[(i / 4) % LEAD.length]);
      nextTime += SIXTEENTH;
      step += 1;
    }
  }

  function start() {
    if (started) {
      if (ctx?.state === 'suspended') ctx.resume();
      return;
    }
    if (!context()) return;
    started = true;
    pump();
    window.setInterval(pump, 80);
  }

  window.addEventListener('pointerdown', start);
  window.addEventListener('keydown', start);

  return { start, setVolume };
}

function readVolume() {
  try {
    return clamp01(localStorage.getItem(STORAGE_KEY) ?? DEFAULT_VOLUME);
  } catch {
    return DEFAULT_VOLUME;
  }
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, n));
}

function distortionCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const y = Math.tanh(x * amount);
    curve[i] = Math.max(-0.9, Math.min(0.9, y));
  }
  return curve;
}
