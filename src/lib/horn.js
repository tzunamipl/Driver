// A two-tone horn. Holding the key ramps it from a quiet beep to full
// volume; releasing cuts it. Other players hear the level carried on the
// pose, quieter the farther away they are. Web Audio only starts after a
// key gesture, which this module treats as the first honk.

const RAMP_S = 2.5;
const QUIET = 0.08;
const FULL_DISTANCE_M = 20;
const SILENT_DISTANCE_M = 120;
const PEAK_GAIN = 0.18;
const TONE_A = 430;
const TONE_B = 510;

export function createHorn() {
  let ctx = null;
  let localGain = null;
  let hold = 0;
  const remotes = new Map();

  // Browsers block audio until a gesture. Driving keys count, so a horn
  // that started while the context was suspended becomes audible on the
  // next keypress.
  window.addEventListener('keydown', () => {
    if (ctx?.state === 'suspended') ctx.resume();
  });

  function context() {
    if (ctx) return ctx;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    ctx = new AudioCtx();
    return ctx;
  }

  function tonePair(destinationGain) {
    const audio = context();
    if (!audio) return null;
    const filter = audio.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1800;
    filter.connect(destinationGain);
    const oscA = audio.createOscillator();
    const oscB = audio.createOscillator();
    oscA.type = 'sawtooth';
    oscB.type = 'sawtooth';
    oscA.frequency.value = TONE_A;
    oscB.frequency.value = TONE_B;
    const mix = audio.createGain();
    mix.gain.value = 0.5;
    oscA.connect(mix);
    oscB.connect(mix);
    mix.connect(filter);
    oscA.start();
    oscB.start();
    return { oscA, oscB, mix, filter };
  }

  function ensureLocal() {
    const audio = context();
    if (!audio || localGain) return;
    localGain = audio.createGain();
    localGain.gain.value = 0;
    localGain.connect(audio.destination);
    tonePair(localGain);
  }

  function remoteVoice(id) {
    let voice = remotes.get(id);
    if (voice) return voice;
    const audio = context();
    if (!audio) return null;
    const gain = audio.createGain();
    gain.gain.value = 0;
    gain.connect(audio.destination);
    const nodes = tonePair(gain);
    if (!nodes) return null;
    voice = { gain, ...nodes };
    remotes.set(id, voice);
    return voice;
  }

  function stopRemote(id) {
    const voice = remotes.get(id);
    if (!voice) return;
    voice.oscA.stop();
    voice.oscB.stop();
    voice.gain.disconnect();
    remotes.delete(id);
  }

  function update(dt, held, listener, poses) {
    if (held) {
      const audio = context();
      if (audio?.state === 'suspended') audio.resume();
      ensureLocal();
      hold = Math.min(RAMP_S, hold + dt);
    } else {
      hold = 0;
    }
    const level = held ? QUIET + (1 - QUIET) * (hold / RAMP_S) : 0;
    if (localGain) localGain.gain.value = level * PEAK_GAIN;

    const heard = new Set();
    const origin = listener;
    if (origin && poses) {
      for (const pose of poses) {
        const remoteLevel = clamp01(pose.horn);
        if (remoteLevel <= 0) continue;
        const dist = Math.hypot(pose.x - origin.x, pose.y - origin.y, pose.z - origin.z);
        const atten = distanceGain(dist);
        const gain = remoteLevel * atten;
        if (gain <= 0.001) continue;
        const voice = remoteVoice(pose.id);
        if (!voice) continue;
        voice.gain.gain.value = gain * PEAK_GAIN;
        heard.add(pose.id);
      }
    }
    for (const id of remotes.keys()) {
      if (!heard.has(id)) stopRemote(id);
    }
    return level;
  }

  return { update };
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1, n);
}

function distanceGain(dist) {
  if (dist <= FULL_DISTANCE_M) return 1;
  if (dist >= SILENT_DISTANCE_M) return 0;
  return 1 - (dist - FULL_DISTANCE_M) / (SILENT_DISTANCE_M - FULL_DISTANCE_M);
}
