import { DEFAULT_BODY_COLOR, VEHICLE_COLORS_STORAGE_KEY, DEFAULT_PAINT_STORAGE_KEY } from '../config.js';
import { getVehicle } from './vehicles/index.js';
import { getGarageColor, setGarageColor } from './garage.js';

// Player's paint per vehicle id (0xRRGGBB): the active game mode's (lib/garage.js), else the one
// picked outside any mode; unset vehicles, or every vehicle while the default-paint toggle is on,
// use the descriptor's defaultColor.

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(VEHICLE_COLORS_STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function save(colors) {
  try {
    localStorage.setItem(VEHICLE_COLORS_STORAGE_KEY, JSON.stringify(colors));
  } catch {
    // Storage unavailable: just don't persist.
  }
}

export function defaultVehicleColor(vehicleId) {
  return getVehicle(vehicleId).defaultColor ?? DEFAULT_BODY_COLOR;
}

export function hasCustomVehicleColor(vehicleId) {
  return getGarageColor(vehicleId) !== null || Number.isInteger(load()[getVehicle(vehicleId).id]);
}

/** The vehicle's own paint, ignoring the default-paint toggle. */
export function getCustomVehicleColor(vehicleId) {
  const color = getGarageColor(vehicleId) ?? load()[getVehicle(vehicleId).id];
  return Number.isInteger(color) ? color : defaultVehicleColor(vehicleId);
}

/** The paint the vehicle drives in. */
export function getVehicleColor(vehicleId) {
  return usesDefaultPaint() ? defaultVehicleColor(vehicleId) : getCustomVehicleColor(vehicleId);
}

export function usesDefaultPaint() {
  try {
    return localStorage.getItem(DEFAULT_PAINT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setUseDefaultPaint(on) {
  try {
    if (on) localStorage.setItem(DEFAULT_PAINT_STORAGE_KEY, '1');
    else localStorage.removeItem(DEFAULT_PAINT_STORAGE_KEY);
  } catch {
    // Storage unavailable: just don't persist.
  }
}

/** Stores a custom colour (in the active mode's garage when there is one); picking the default colour clears the override. */
export function setVehicleColor(vehicleId, color) {
  if (setGarageColor(vehicleId, color)) return;
  const id = getVehicle(vehicleId).id;
  const colors = load();
  if (color === defaultVehicleColor(id)) delete colors[id];
  else colors[id] = color;
  save(colors);
}
