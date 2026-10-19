// HUD volume sliders: master (every sound) and music bus, each remembered in localStorage.

import { setVolume } from './audioContext.js';

const DEFAULT_VOLUME = 1;
const SLIDERS = [
  { id: 'volume-input', bus: 'master', storageKey: 'driver-volume' },
  { id: 'music-volume-input', bus: 'music', storageKey: 'driver-music-volume' },
];

export function createVolumeSliders() {
  for (const { id, bus, storageKey } of SLIDERS) bindSlider(document.getElementById(id), bus, storageKey);
}

function bindSlider(slider, bus, storageKey) {
  const volume = readVolume(storageKey);
  if (slider) slider.value = String(volume);
  setVolume(bus, volume);

  slider?.addEventListener('input', () => {
    const next = clamp01(slider.value);
    try { localStorage.setItem(storageKey, String(next)); } catch { /* private mode */ }
    setVolume(bus, next);
  });
}

function readVolume(storageKey) {
  try {
    return clamp01(localStorage.getItem(storageKey) ?? DEFAULT_VOLUME);
  } catch {
    return DEFAULT_VOLUME;
  }
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_VOLUME;
  return Math.min(1, Math.max(0, n));
}
