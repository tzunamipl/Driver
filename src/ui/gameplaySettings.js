// Settings "Gameplay" section: display units (lib/units.js), gearbox modes in use, cruise speed limits
// and per-mode driving options, remembered in localStorage.

import {
  RALLY_HANDBRAKE_HOLD_STORAGE_KEY,
  GEAR_MODES_ENABLED_STORAGE_KEY,
  FREE_ROAM_HANDBRAKE_HOLD_STORAGE_KEY,
  FREE_ROAM_PAINT_DAMAGE_STORAGE_KEY,
  FREE_ROAM_DIRT_DAMAGE_STORAGE_KEY,
} from '../config.js';
import { GEAR_MODES } from '../lib/engine.js';
import { getUnits, setUnits, onUnitsChange, speedValue, speedFromValue, speedUnit } from '../lib/units.js';
import { getCruiseLimits, setCruiseLimit } from '../app/speedLimit.js';

export function createGameplaySettings() {
  const unitsSelect = document.getElementById('units-select');
  unitsSelect.value = getUnits();
  unitsSelect.addEventListener('change', () => {
    setUnits(unitsSelect.value);
    unitsSelect.blur(); // driving keys mustn't keep working the select
  });

  let gearModes = readGearModes();
  const gearModesEl = document.getElementById('gear-modes-enabled');
  const gearModeInputs = GEAR_MODES.map((mode) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = gearModes.includes(mode);
    input.addEventListener('change', () => {
      const checked = GEAR_MODES.filter((_, i) => gearModeInputs[i].checked);
      // One mode always stays on.
      if (checked.length) gearModes = checked;
      else input.checked = true;
      try { localStorage.setItem(GEAR_MODES_ENABLED_STORAGE_KEY, JSON.stringify(gearModes)); } catch { /* private mode */ }
      input.blur();
    });
    label.append(input, mode[0].toUpperCase() + mode.slice(1));
    gearModesEl?.appendChild(label);
    return input;
  });

  const limitsUnitEl = document.getElementById('cruise-limits-unit');
  const limitInputs = Object.keys(getCruiseLimits()).map((zone) => {
    const input = document.getElementById(`cruise-limit-${zone}`);
    input?.addEventListener('change', () => {
      const kmh = setCruiseLimit(zone, speedFromValue(Number(input.value)));
      input.value = String(Math.round(speedValue(kmh)));
      input.blur();
    });
    return { zone, input };
  });
  function showLimits() {
    if (limitsUnitEl) limitsUnitEl.textContent = speedUnit();
    const limits = getCruiseLimits();
    for (const { zone, input } of limitInputs) {
      if (input) input.value = String(Math.round(speedValue(limits[zone])));
    }
  }
  showLimits();
  onUnitsChange(showLimits);

  const rallyHandbrakeHold = flagCheckbox('rally-handbrake-hold-input', RALLY_HANDBRAKE_HOLD_STORAGE_KEY, false);
  const freeRoamHandbrakeHold = flagCheckbox('free-roam-handbrake-hold-input', FREE_ROAM_HANDBRAKE_HOLD_STORAGE_KEY, true);
  const paintDamage = flagCheckbox('free-roam-paint-damage-input', FREE_ROAM_PAINT_DAMAGE_STORAGE_KEY, true);
  const dirtDamage = flagCheckbox('free-roam-dirt-damage-input', FREE_ROAM_DIRT_DAMAGE_STORAGE_KEY, false);

  return {
    /** Automatic gearbox modes the mode button cycles through (never empty). */
    gearModes: () => gearModes,
    /** Rally: holding Space locks the handbrake on. */
    rallyHandbrakeHold: () => rallyHandbrakeHold.checked,
    /** Free roam: holding Space locks the handbrake on. */
    freeRoamHandbrakeHold: () => freeRoamHandbrakeHold.checked,
    /** Free roam: scratched paint gets a roadside fix. */
    paintDamage: () => paintDamage.checked,
    /** Free roam: body / rim dirt gets a roadside fix. */
    dirtDamage: () => dirtDamage.checked,
  };
}

function readGearModes() {
  try {
    const saved = JSON.parse(localStorage.getItem(GEAR_MODES_ENABLED_STORAGE_KEY));
    const modes = GEAR_MODES.filter((mode) => saved.includes(mode));
    return modes.length ? modes : GEAR_MODES;
  } catch {
    return GEAR_MODES;
  }
}

/** Checkbox `id` kept in localStorage under `key`. */
function flagCheckbox(id, key, fallback) {
  const input = document.getElementById(id);
  input.checked = readFlag(key, fallback);
  input.addEventListener('change', () => {
    try { localStorage.setItem(key, String(input.checked)); } catch { /* private mode */ }
    input.blur(); // Space is the handbrake, not a checkbox toggle
  });
  return input;
}

function readFlag(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}
