import { getActiveModeId, readSaveField, writeSaveField } from './saves.js';
import { getVehicle } from './vehicles/index.js';
import { sanitizeTyreSetup } from './tyres/setup.js';

// Per game mode, per vehicle: the paint and tyre setup last picked, in the mode-wide save
// field `garage` ({ [vehicleId]: { color?, tyres? } }). Before a mode is picked there is none.

const entry = (vehicleId) => readSaveField('garage')?.[getVehicle(vehicleId).id] ?? null;

function update(vehicleId, patch) {
  if (!getActiveModeId()) return false;
  const id = getVehicle(vehicleId).id;
  const garage = readSaveField('garage') ?? {};
  garage[id] = { ...garage[id], ...patch };
  writeSaveField('garage', garage);
  return true;
}

/** This mode's paint for the vehicle, or null when never picked here. */
export function getGarageColor(vehicleId) {
  const color = entry(vehicleId)?.color;
  return Number.isInteger(color) ? color : null;
}

/** False when no mode is active (nothing stored). */
export const setGarageColor = (vehicleId, color) => update(vehicleId, { color });

/** This mode's tyre setup for the vehicle (tyres/setup.js), stock when never picked here. */
export const getTyreSetup = (vehicleId) => sanitizeTyreSetup(getVehicle(vehicleId), entry(vehicleId)?.tyres);

export const setTyreSetup = (vehicleId, setup) => update(vehicleId, { tyres: sanitizeTyreSetup(getVehicle(vehicleId), setup) });
