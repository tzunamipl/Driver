// Settings "Gameplay" section: display units (lib/units.js) and per-mode driving options, remembered in localStorage.

import { RALLY_HANDBRAKE_HOLD_STORAGE_KEY } from '../config.js';
import { getUnits, setUnits } from '../lib/units.js';

export function createGameplaySettings() {
  const unitsSelect = document.getElementById('units-select');
  unitsSelect.value = getUnits();
  unitsSelect.addEventListener('change', () => {
    setUnits(unitsSelect.value);
    unitsSelect.blur(); // driving keys mustn't keep working the select
  });

  const rallyHandbrakeHold = document.getElementById('rally-handbrake-hold-input');
  rallyHandbrakeHold.checked = readFlag(RALLY_HANDBRAKE_HOLD_STORAGE_KEY, false);
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
