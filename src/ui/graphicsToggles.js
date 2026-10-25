// Settings "Graphics" checkboxes: road surface view and car dirt, remembered in localStorage.
// The debug layers panel mirrors them through the same toggles.

import { CAR_DIRT_STORAGE_KEY, ROAD_SURFACE_STORAGE_KEY } from '../config.js';

/** Reads the boxes now (the main menu shows them before the world exists); `bind` applies them. */
export function createGraphicsToggles() {
  let targets = null;
  const roadSurface = createToggle('road-surface-input', ROAD_SURFACE_STORAGE_KEY, false);
  const carDirt = createToggle('car-dirt-input', CAR_DIRT_STORAGE_KEY, true);
  roadSurface.onChange((on) => targets?.streets.setSurfaceVisible(on));

  return {
    /** Applies the road surface view now and on every change. */
    bind(subsystems) {
      targets = subsystems;
      targets.streets.setSurfaceVisible(roadSurface.get());
    },
    roadSurface,
    carDirt,
  };
}

/** A remembered checkbox: { get, set(on), onChange(fn) }; set() updates the box and tells the listeners. */
function createToggle(id, key, fallback) {
  const input = document.getElementById(id);
  const listeners = [];
  input.checked = readFlag(key, fallback);

  function set(on) {
    input.checked = on;
    try { localStorage.setItem(key, String(on)); } catch { /* private mode */ }
    for (const fn of listeners) fn(on);
  }

  input.addEventListener('change', () => {
    set(input.checked);
    input.blur(); // Space is the handbrake, not a checkbox toggle
  });

  return {
    get: () => input.checked,
    set,
    onChange: (fn) => listeners.push(fn),
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
