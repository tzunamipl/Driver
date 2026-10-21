import {
  SAVES_STORAGE_KEY,
  CAR_STATE_STORAGE_KEY,
  NAV_DESTINATION_STORAGE_KEY,
  CAMERA_VIEW_STORAGE_KEY,
  LOBBY_STORAGE_KEY,
} from '../config.js';
import { DEFAULT_GAME_MODE_ID } from '../app/gameModes.js';

// One save slot per game mode in a single localStorage entry:
// { latest: modeId, modes: { [modeId]: { savedAt, carState, vehicle, navDestination, cameraView } } }.
// Fields read and written here belong to the active mode, picked once at launch.

let activeModeId = null;

function readStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVES_STORAGE_KEY));
    if (parsed && typeof parsed.modes === 'object' && parsed.modes) return parsed;
  } catch {
    // Unreadable: start over.
  }
  return migrateLegacy();
}

function writeStore(store) {
  try {
    localStorage.setItem(SAVES_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage unavailable: progress lasts this session only.
  }
}

/** Saves from before game modes become the Free Roam slot. */
function migrateLegacy() {
  const store = { latest: null, modes: {} };
  try {
    const carState = JSON.parse(localStorage.getItem(CAR_STATE_STORAGE_KEY));
    if (!carState) return store;
    const lobby = JSON.parse(localStorage.getItem(LOBBY_STORAGE_KEY));
    const color = Number.parseInt(String(lobby?.color ?? '').replace('#', ''), 16);
    store.latest = DEFAULT_GAME_MODE_ID;
    store.modes[DEFAULT_GAME_MODE_ID] = {
      savedAt: Date.now(),
      carState,
      vehicle: typeof lobby?.vehicleId === 'string' && Number.isInteger(color) ? { vehicleId: lobby.vehicleId, color } : null,
      navDestination: JSON.parse(localStorage.getItem(NAV_DESTINATION_STORAGE_KEY)),
      cameraView: localStorage.getItem(CAMERA_VIEW_STORAGE_KEY),
    };
    writeStore(store);
  } catch {
    // Broken legacy data: nothing to carry over.
  }
  return store;
}

/** Last played mode, or null before the first game. */
export const getLatestModeId = () => readStore().latest ?? null;

/** Summary for the menu: { savedAt, odoKm } or null without a save. */
export function getSaveInfo(modeId) {
  const slot = readStore().modes[modeId];
  if (!slot?.carState) return null;
  return { savedAt: slot.savedAt ?? null, odoKm: slot.carState.odoKm ?? 0 };
}

export function clearSave(modeId) {
  const store = readStore();
  delete store.modes[modeId];
  writeStore(store);
}

/** Picks the mode this session plays and marks it as the latest. */
export function setActiveMode(modeId) {
  activeModeId = modeId;
  const store = readStore();
  store.latest = modeId;
  writeStore(store);
}

export const getActiveModeId = () => activeModeId;

/** A field of the active mode's slot; null before launch or when unset. */
export function readSaveField(field) {
  if (!activeModeId) return null;
  return readStore().modes[activeModeId]?.[field] ?? null;
}

export function writeSaveField(field, value) {
  if (!activeModeId) return;
  const store = readStore();
  const slot = (store.modes[activeModeId] ??= {});
  slot[field] = value;
  slot.savedAt = Date.now();
  writeStore(store);
}
