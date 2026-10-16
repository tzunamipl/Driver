// Debug-view time presets: freeze the day-night cycle at noon, sunset or night. The choice persists.

import { TIME_PRESET_STORAGE_KEY } from '../config.js';

const PRESETS = [
  { id: null, label: 'Live' },
  { id: 'noon', label: 'Noon' },
  { id: 'sunset', label: 'Sunset' },
  { id: 'night', label: 'Night' },
];

/**
 * @param {HTMLElement} listEl - container the preset buttons go into
 * @param {{ setTimePreset: (id: string | null) => void, getTimePreset: () => string | null }} daylight
 */
export function createTimeOfDayPicker(listEl, daylight) {
  try {
    const saved = localStorage.getItem(TIME_PRESET_STORAGE_KEY);
    if (PRESETS.some(({ id }) => id && id === saved)) daylight.setTimePreset(saved);
  } catch {
    // Storage unavailable: live cycle.
  }

  const buttons = PRESETS.map(({ id, label }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'debug-time-btn';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      daylight.setTimePreset(id);
      try {
        if (id) localStorage.setItem(TIME_PRESET_STORAGE_KEY, id);
        else localStorage.removeItem(TIME_PRESET_STORAGE_KEY);
      } catch {
        // Storage unavailable: just don't persist.
      }
      sync();
      btn.blur(); // keep keyboard driving working after a click
    });
    listEl.append(btn);
    return btn;
  });

  function sync() {
    const active = daylight.getTimePreset();
    buttons.forEach((btn, i) => btn.classList.toggle('active', PRESETS[i].id === active));
  }

  sync();
}
