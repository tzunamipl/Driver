// Debug-view vehicle/colour picker (dev mode has no lobby): swaps the car
// live via carManager, broadcasts via net, and persists the pick to
// DEV_CAR_STORAGE_KEY for the next dev-mode join. Paint goes through the shared
// per-vehicle colours (ui/vehicleColorPicker.js), stored as it changes.

import { createVehiclePicker } from '../ui/vehiclePicker.js';
import { createVehicleColorPicker } from '../ui/vehicleColorPicker.js';
import { DEV_CAR_STORAGE_KEY } from '../config.js';
import { DEFAULT_VEHICLE_ID } from '../lib/vehicles/index.js';
import { getVehicleColor } from '../lib/vehicleColors.js';

/** Saved dev-mode car/colour pick, if any. */
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
    // Storage unavailable: just don't persist.
  }
}

/**
 * @param {object} deps
 * @param {import('../app/carManager.js').CarManager} deps.carManager
 * @param {ReturnType<import('../lib/net.js').createNet>} deps.net
 * @param {HTMLElement} deps.tabsEl
 * @param {HTMLElement} deps.listEl
 * @param {HTMLElement} [deps.colorEl] - container for the paint widget
 * @param {string} [deps.initialVehicleId] - initial highlight (saved pick before spawn)
 */
export function createVehicleDebugPicker({ carManager, net, tabsEl, listEl, colorEl, initialVehicleId }) {
  const picker = createVehiclePicker({
    tabsEl,
    listEl,
    initialVehicleId: initialVehicleId ?? carManager.getVehicleId(),
    onSelect: (vehicleId) => {
      const color = getVehicleColor(vehicleId);
      carManager.setVehicleKind(vehicleId, color);
      net.setVehicleId(vehicleId);
      net.setColor(color);
      colors?.show(vehicleId);
      saveDevCarChoice(color, vehicleId);
    },
  });

  // Live: every edit repaints the car and is stored straight away.
  const colors = colorEl
    ? createVehicleColorPicker({
        onChange: (color) => {
          colors?.commit();
          if (!carManager.getVehicle() || color === carManager.getColor()) return;
          carManager.setColor(color);
          net.setColor(color);
          saveDevCarChoice(color, carManager.getVehicleId() ?? DEFAULT_VEHICLE_ID);
        },
      })
    : null;
  if (colors) {
    colorEl.append(colors.el);
    colors.show(picker.getSelectedId());
  }

  return {
    // Re-sync with the actual car after a (re)spawn.
    syncFromCar: () => {
      picker.select(carManager.getVehicleId());
      colors?.show(carManager.getVehicleId());
    },
  };
}
