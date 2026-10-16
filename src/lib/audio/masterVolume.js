// The HUD volume slider drives the master bus (every sound), remembered in localStorage.

import { setVolume } from './audioContext.js';

const DEFAULT_VOLUME = 1;
const STORAGE_KEY = 'driver-volume';

export function createMasterVolume() {
  const slider = document.getElementById('volume-input');
  const volume = readVolume();
  if (slider) slider.value = String(volume);
  setVolume('master', volume);

  slider?.addEventListener('input', () => {
    const next = clamp01(slider.value);
    try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* private mode */ }
    setVolume('master', next);
  });
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
