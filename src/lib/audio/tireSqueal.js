// Tyre screech: detuned tones, audible while any wheel slides on 'road'
// (same condition as tireSmoke.js).

import { getAudio } from './audioContext.js';

const TONES = [
  { freq: 700, type: 'sine', gain: 0.01 },
  { freq: 900, type: 'triangle', gain: 0.008 },
  { freq: 1500, type: 'sawtooth', gain: 0.003 },
];

export function createTireSqueal() {
  const audio = getAudio();
  if (!audio) return { update() {} };
  const { ctx, buses } = audio;

  const voices = TONES.map((tone) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = tone.type;
    osc.frequency.value = tone.freq;
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(buses.carSfx);
    osc.start();
    return { ...tone, osc, gainNode: gain };
  });

  /** @param {object|null} vehicle - wheeledVehicle.js vehicle, or null. */
  function update(vehicle) {
    const sliding = !!vehicle?.wheelInfos?.some((w) => w.sliding && w.surface === 'road');
    const now = ctx.currentTime;
    for (const v of voices) {
      const variation = Math.sin((now + (Math.random() - 0.5)) * 10) * 100;
      v.osc.frequency.setTargetAtTime(v.freq + variation, now, 0.03);
      v.gainNode.gain.setTargetAtTime(sliding ? v.gain * (0.8 + 0.2 * Math.sin(now * 18)) : 0, now, 0.05);
    }
  }

  return { update };
}
