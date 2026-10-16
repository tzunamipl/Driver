// Debug-view vehicle/colour picker (dev mode has no lobby): swaps the car
// live via carManager, broadcasts via net, and persists the pick to
// DEV_CAR_STORAGE_KEY for the next dev-mode join. Switching vehicles always
// starts from the vehicle's default colour.

import { createVehiclePicker } from '../ui/vehiclePicker.js';
import { DEFAULT_BODY_COLOR, DEV_CAR_STORAGE_KEY } from '../config.js';
import { DEFAULT_VEHICLE_ID } from '../lib/vehicles/index.js';
import { defaultVehicleColor } from '../lib/vehicleColors.js';

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

function colorToHex(color) {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/**
 * @param {object} deps
 * @param {import('../app/carManager.js').CarManager} deps.carManager
 * @param {ReturnType<import('../lib/net.js').createNet>} deps.net
 * @param {HTMLElement} deps.tabsEl
 * @param {HTMLElement} deps.listEl
 * @param {HTMLInputElement} [deps.colorEl] - colour input
 * @param {string} [deps.initialVehicleId] - initial highlight (saved pick before spawn)
 * @param {number} [deps.initialColor]
 */
export function createVehicleDebugPicker({ carManager, net, tabsEl, listEl, colorEl, initialVehicleId, initialColor }) {
  const picker = createVehiclePicker({
    tabsEl,
    listEl,
    initialVehicleId: initialVehicleId ?? carManager.getVehicleId(),
    onSelect: (vehicleId) => {
      const color = defaultVehicleColor(vehicleId);
      carManager.setVehicleKind(vehicleId, color);
      net.setVehicleId(vehicleId);
      net.setColor(color);
      if (colorEl) colorEl.value = colorToHex(color);
      saveDevCarChoice(color, vehicleId);
    },
  });

  if (colorEl) {
    colorEl.value = colorToHex(initialColor ?? carManager.getColor() ?? DEFAULT_BODY_COLOR);
    colorEl.addEventListener('input', () => {
      const hex = String(colorEl.value || '').replace('#', '');
      const n = Number.parseInt(hex, 16);
      const color = Number.isInteger(n) && n >= 0 && n <= 0xffffff ? n : DEFAULT_BODY_COLOR;
      const vehicleId = carManager.getVehicleId() ?? DEFAULT_VEHICLE_ID;
      carManager.setColor(color);
      net.setColor(color);
      saveDevCarChoice(color, vehicleId);
    });
  }

  return {
    // Re-sync with the actual car after a (re)spawn.
    syncFromCar: () => {
      picker.select(carManager.getVehicleId());
      if (colorEl) colorEl.value = colorToHex(carManager.getColor() ?? DEFAULT_BODY_COLOR);
    },
  };
}
