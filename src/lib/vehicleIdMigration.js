import {
  SAVES_STORAGE_KEY,
  LOBBY_STORAGE_KEY,
  VEHICLE_ODOMETERS_STORAGE_KEY,
  VEHICLE_COLORS_STORAGE_KEY,
  DEV_CAR_STORAGE_KEY,
} from '../config.js';
import { currentVehicleId } from './vehicles/legacyIds.js';

// Rewrites legacy vehicle ids (vehicles/legacyIds.js) in stored data. Idempotent; run after the
// cloud restore, which may bring back an old copy.

const renameKeys = (map) => Object.fromEntries(Object.entries(map).map(([id, v]) => [currentVehicleId(id), v]));

/** `vehicleId` / `vehicle` string fields anywhere, plus each slot's `garage` keys. */
function migrateIds(value, key) {
  if (Array.isArray(value)) return value.map((v) => migrateIds(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = migrateIds(k === 'garage' && v && typeof v === 'object' ? renameKeys(v) : v, k);
    return out;
  }
  return typeof value === 'string' && (key === 'vehicleId' || key === 'vehicle') ? currentVehicleId(value) : value;
}

const STORES = [
  [SAVES_STORAGE_KEY, (data) => migrateIds(data)],
  [LOBBY_STORAGE_KEY, (data) => migrateIds(data)],
  [DEV_CAR_STORAGE_KEY, (data) => migrateIds(data)],
  [VEHICLE_ODOMETERS_STORAGE_KEY, renameKeys],
  [VEHICLE_COLORS_STORAGE_KEY, renameKeys],
];

export function migrateStoredVehicleIds() {
  for (const [storageKey, migrate] of STORES) {
    try {
      const raw = localStorage.getItem(storageKey);
      const data = raw && JSON.parse(raw);
      if (!data || typeof data !== 'object') continue;
      const next = JSON.stringify(migrate(data));
      if (next !== raw) localStorage.setItem(storageKey, next);
    } catch {
      // Unreadable or storage unavailable: getVehicle() still resolves legacy ids.
    }
  }
}
