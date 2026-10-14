import * as THREE from 'three';

export function createEngineAudio(camera, frequencies) {

  const ctx = new AudioContext();
  const listener = new THREE.AudioListener();
  camera.add(listener);

  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 500;
  filter.connect(master);

  const oscillators = frequencies.map(({ freq, pitchD, pitchT, variation, vibration, vibrationT }) => {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = freq;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    osc.connect(gain);
    gain.connect(filter);
    osc.start();

    return {
      osc,
      gain,
      baseFrequency: freq,
      pitchD: pitchD,
      pitchT: pitchT,
      variation: variation,
      vibration: vibration,
      vibrationT: vibrationT,
      rumbleA: 0,
      pitchA: 0,
    };
  });

  return {
    update(rpm, throttle = 0.5) {
      if (ctx.state !== 'running') ctx.resume();

      const now = ctx.currentTime;
      const normalized = Math.max(0, Math.min(1, rpm / 6500 / 2));

      for (const o of oscillators) {
        o.rumbleA += o.vibrationT / 30 * Math.PI + normalized;
        o.pitchA += o.pitchT / 30 * Math.PI + normalized;
        const frequency = o.baseFrequency + normalized * o.baseFrequency * o.variation + Math.sin(o.pitchA) * o.pitchD;
        const rumble = Math.sin(o.rumbleA) * o.vibration;

        o.osc.frequency.setTargetAtTime(frequency, now, 0.05);
        o.gain.gain.setTargetAtTime(Math.max(0, 0.08 + throttle * 0.1 * normalized + rumble), now, 0.05);
        console.log(frequency);
      }


      filter.frequency.setTargetAtTime(
          250 + normalized * 250,
          now,
          0.5
      );
    },

    stop() {
      for (const o of oscillators) {
        o.osc.stop();
      }
      ctx.close();
    }
  };
}