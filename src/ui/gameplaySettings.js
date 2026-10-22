// Settings "Gameplay" section: per-mode driving options, remembered in localStorage.

import { RALLY_HANDBRAKE_HOLD_STORAGE_KEY } from '../config.js';

export function createGameplaySettings() {
  const rallyHandbrakeHold = document.getElementById('rally-handbrake-hold-input');
  rallyHandbrakeHold.checked = readFlag(RALLY_HANDBRAKE_HOLD_STORAGE_KEY, true);
  rallyHandbrakeHold.addEventListener('change', () => {
    try { localStorage.setItem(RALLY_HANDBRAKE_HOLD_STORAGE_KEY, String(rallyHandbrakeHold.checked)); } catch { /* private mode */ }
    rallyHandbrakeHold.blur(); // Space is the handbrake, not a checkbox toggle
  });

  return {
    /** Rally: holding Space locks the handbrake on. */
    rallyHandbrakeHold: () => rallyHandbrakeHold.checked,
  };
}

function readFlag(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}
