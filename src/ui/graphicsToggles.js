// Settings "Graphics" checkboxes: road surface view, car dirt and road signs + posts + barriers, remembered in localStorage.
// The debug layers panel mirrors them through the same toggles.

import { CAR_DIRT_STORAGE_KEY, IS_MOBILE, ROAD_SIGNS_STORAGE_KEY, ROAD_SURFACE_STORAGE_KEY } from '../config.js';

const ROAD_SIGN_GROUPS = ['curveSigns', 'directionSigns', 'roadPosts', 'guardRails'];

/** Reads the boxes now (the main menu shows them before the world exists); `bind` applies them. */
export function createGraphicsToggles() {
  let targets = null;
  const roadSurface = createToggle('road-surface-input', ROAD_SURFACE_STORAGE_KEY, true);
  const carDirt = createToggle('car-dirt-input', CAR_DIRT_STORAGE_KEY, true);
  const roadSigns = createToggle('road-signs-input', ROAD_SIGNS_STORAGE_KEY, !IS_MOBILE);
  const applyRoadSigns = (on) => {
    for (const group of ROAD_SIGN_GROUPS) targets?.roadside.setGroupAllowed(group, on);
  };
  roadSurface.onChange((on) => targets?.streets.setSurfaceVisible(on));
  roadSigns.onChange(applyRoadSigns);

  return {
    /** Applies the road surface view and road signs now and on every change. */
    bind(subsystems) {
      targets = subsystems;
      targets.streets.setSurfaceVisible(roadSurface.get());
      applyRoadSigns(roadSigns.get());
    },
    roadSurface,
    carDirt,
    roadSigns,
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
