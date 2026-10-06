// Instant vehicle/color picker for the debug view (toggled with M alongside
// #suspension-hud/#terrain-stats, see hud/debugVisuals.js). Reuses the same
// tabs + list widget as the lobby (ui/vehiclePicker.js) but, instead of just
// recording a choice to join with, swaps the local car's vehicle kind/color
// live via carManager.setVehicleKind()/setColor() and broadcasts them to
// peers via net.setVehicleId()/setColor(). Dev mode never shows the lobby
// form (see ui/lobby.js), so this is the only place to change either while
// driving - both choices are persisted to DEV_CAR_STORAGE_KEY so they
// survive a reload instead of snapping back to the default every time (see
// loadDevCarChoice()/saveDevCarChoice() below, used by main.js at dev-mode
// join time).

import { createVehiclePicker } from '../ui/vehiclePicker.js';
import { DEFAULT_BODY_COLOR, DEV_CAR_STORAGE_KEY } from '../config.js';
import { DEFAULT_VEHICLE_ID } from '../lib/vehicles/index.js';

/** Reads the last dev-mode car/color pick, if any, from localStorage. */
export function loadDevCarChoice() {
  try {
    const raw = localStorage.getItem(DEV_CAR_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.color !== 'number' || typeof parsed.vehicleId !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveDevCarChoice(color, vehicleId) {
  try {
    localStorage.setItem(DEV_CAR_STORAGE_KEY, JSON.stringify({ color, vehicleId }));
  } catch {
    // Storage unavailable (private browsing, quota, etc.) - not persisting
    // is a harmless degradation, so silently ignore.
  }
}

function colorToHex(color) {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/**
 * @param {object} deps
 * @param {import('../app/carManager.js').CarManager} deps.carManager
 * @param {ReturnType<import('../lib/net.js').createNet>} deps.net
 * @param {HTMLElement} deps.tabsEl
 * @param {HTMLElement} deps.listEl
 * @param {HTMLInputElement} [deps.colorEl] - the <input type="color"> in
 *   the debug HUD; optional so tests/other call sites that don't need
 *   color picking can omit it.
 * @param {string} [deps.initialVehicleId] - overrides carManager's
 *   current vehicle for the picker's initial highlight (e.g. a saved dev
 *   choice applied before the car actually spawns with it).
 * @param {number} [deps.initialColor] - same, for the color input's
 *   initial value.
 */
export function createVehicleDebugPicker({ carManager, net, tabsEl, listEl, colorEl, initialVehicleId, initialColor }) {
  const picker = createVehiclePicker({
    tabsEl,
    listEl,
    initialVehicleId: initialVehicleId ?? carManager.getVehicleId(),
    onSelect: (vehicleId) => {
      carManager.setVehicleKind(vehicleId);
      net.setVehicleId(vehicleId);
      saveDevCarChoice(carManager.getColor(), vehicleId);
    },
  });

  if (colorEl) {
    colorEl.value = colorToHex(initialColor ?? carManager.getColor() ?? DEFAULT_BODY_COLOR);
    colorEl.addEventListener('input', () => {
      const hex = String(colorEl.value || '').replace('#', '');
      const n = Number.parseInt(hex, 16);
      const color = Number.isInteger(n) && n >= 0 && n <= 0xffffff ? n : DEFAULT_BODY_COLOR;
      carManager.setColor(color);
      net.setColor(color);
      saveDevCarChoice(color, carManager.getVehicleId() ?? DEFAULT_VEHICLE_ID);
    });
  }

  return {
    // Re-highlights whatever vehicle/color the car actually is - call
    // after the local car (re)spawns (e.g. on join) so this panel never
    // disagrees with the lobby's choice.
    syncFromCar: () => {
      picker.select(carManager.getVehicleId());
      if (colorEl) colorEl.value = colorToHex(carManager.getColor() ?? DEFAULT_BODY_COLOR);
    },
  };
}
