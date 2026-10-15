import { DEFAULT_BODY_COLOR, VEHICLE_COLORS_STORAGE_KEY } from '../config.js';
import { getVehicle } from './vehicles/index.js';

// Player's paint per vehicle id (0xRRGGBB); unset vehicles use the descriptor's defaultColor.

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
  return Number.isInteger(load()[getVehicle(vehicleId).id]);
}

export function getVehicleColor(vehicleId) {
  const color = load()[getVehicle(vehicleId).id];
  return Number.isInteger(color) ? color : defaultVehicleColor(vehicleId);
}

/** Stores a custom colour; picking the default colour clears the override. */
export function setVehicleColor(vehicleId, color) {
  const id = getVehicle(vehicleId).id;
  const colors = load();
  if (color === defaultVehicleColor(id)) delete colors[id];
  else colors[id] = color;
  save(colors);
}
