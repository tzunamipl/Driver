import { DEFAULT_BODY_COLOR, VEHICLE_COLORS_STORAGE_KEY, DEFAULT_PAINT_STORAGE_KEY } from '../config.js';
import { getVehicle, VEHICLES } from './vehicles/index.js';
import { getGarageColor, setGarageColor } from './garage.js';

// Player's paint per vehicle id (0xRRGGBB): the active game mode's (lib/garage.js), else the one
// picked outside any mode; unset vehicles, or vehicles with their default-paint toggle on,
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
  return usesDefaultPaint(vehicleId) ? defaultVehicleColor(vehicleId) : getCustomVehicleColor(vehicleId);
}

// Vehicle ids with the default-paint toggle on; the legacy '1' meant every car.
function loadDefaultPaintIds() {
  try {
    const raw = localStorage.getItem(DEFAULT_PAINT_STORAGE_KEY);
    if (raw === '1') return new Set(VEHICLES.map((v) => v.id));
    const parsed = JSON.parse(raw ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

export function usesDefaultPaint(vehicleId) {
  return loadDefaultPaintIds().has(getVehicle(vehicleId).id);
}

export function setUseDefaultPaint(vehicleId, on) {
  const ids = loadDefaultPaintIds();
  const id = getVehicle(vehicleId).id;
  if (on) ids.add(id);
  else ids.delete(id);
  try {
    if (ids.size) localStorage.setItem(DEFAULT_PAINT_STORAGE_KEY, JSON.stringify([...ids]));
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
