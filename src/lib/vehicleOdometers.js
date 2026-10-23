import { VEHICLE_ODOMETERS_STORAGE_KEY } from '../config.js';
import { getVehicle } from './vehicles/index.js';

// Odometer reading (km) per vehicle id, shared by every game mode and save slot.

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(VEHICLE_ODOMETERS_STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getVehicleOdometerKm(vehicleId) {
  const km = load()[getVehicle(vehicleId).id];
  return Number.isFinite(km) && km >= 0 ? km : 0;
}

export function setVehicleOdometerKm(vehicleId, km) {
  const odometers = load();
  odometers[getVehicle(vehicleId).id] = km;
  try {
    localStorage.setItem(VEHICLE_ODOMETERS_STORAGE_KEY, JSON.stringify(odometers));
  } catch {
    // Storage unavailable: just don't persist.
  }
}
