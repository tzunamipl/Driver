import {
  SAVES_STORAGE_KEY,
  CAR_STATE_STORAGE_KEY,
  NAV_DESTINATION_STORAGE_KEY,
  CAMERA_VIEW_STORAGE_KEY,
  LOBBY_STORAGE_KEY,
} from '../config.js';
import { DEFAULT_GAME_MODE_ID } from '../app/gameModes.js';

// One save slot per game mode (per mode + start for modes with starts) in a single localStorage entry:
// { latest: { modeId, startId }, lastLaunch: { modeId, editor, startId }, modes: { [slotId]: { savedAt, carState, vehicle, navDestination, cameraView, status, done } } }.
// Slot ids: `<modeId>`, `<modeId>.<startId>` (e.g. rally.career), `<modeId>.editor`.
// `latest` is the last played game that keeps progress (Continue); `lastLaunch` also counts editor sessions
// and starts that keep nothing (dev-mode startup). Fields read and written here belong to the active slot,
// picked once at launch, so a mode's editor sessions and starts never touch each other's saves.

let activeModeId = null;
let activeStartId = null;
let editorSession = false;
const slotId = (modeId, startId) => (startId ? `${modeId}.${startId}` : modeId);
const activeSlotId = () => (editorSession ? `${activeModeId}.editor` : slotId(activeModeId, activeStartId));

// Settings of the whole mode, not of one game: shared with its editor and starts, kept by a new game.
const MODE_WIDE_FIELDS = new Set(['cameraView', 'debugFolded', 'garage']);
const slotFor = (field) => (MODE_WIDE_FIELDS.has(field) ? activeModeId : activeSlotId());

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
    store.latest = { modeId: DEFAULT_GAME_MODE_ID, startId: null };
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

/** Last played game that keeps progress: { modeId, startId }, or null before the first one. */
export function getLatest() {
  const latest = readStore().latest;
  // Saves from before starts had their own slots: a bare mode id.
  if (typeof latest === 'string') return { modeId: latest, startId: null };
  return latest?.modeId ? { modeId: latest.modeId, startId: latest.startId ?? null } : null;
}

/** Summary for the menu: { savedAt, odoKm, status, done } or null without a save; `done` = the game is over, nothing to resume. */
export function getSaveInfo(modeId, startId = null) {
  const slot = readStore().modes[slotId(modeId, startId)];
  if (!slot?.carState) return null;
  return { savedAt: slot.savedAt ?? null, odoKm: slot.carState.odoKm ?? 0, status: slot.status ?? null, done: !!slot.done };
}

/** Empties a game's slot, except the `keep` fields (e.g. the last picked car). */
export function clearSave(modeId, startId = null, keep = []) {
  const store = readStore();
  const id = slotId(modeId, startId);
  const slot = store.modes[id];
  // Without a start the slot also holds the mode-wide fields.
  const kept = Object.fromEntries([...keep, ...(startId ? [] : MODE_WIDE_FIELDS)].filter((field) => slot?.[field] != null).map((field) => [field, slot[field]]));
  if (Object.keys(kept).length) store.modes[id] = kept;
  else delete store.modes[id];
  writeStore(store);
}

/**
 * Picks the game this session plays (or edits).
 * @param {{editor?: boolean, startId?: string | null, keepsProgress?: boolean}} [opts] - a played game that keeps progress becomes the latest.
 */
export function setActiveMode(modeId, { editor = false, startId = null, keepsProgress = true } = {}) {
  activeModeId = modeId;
  activeStartId = editor ? null : startId;
  editorSession = editor;
  const store = readStore();
  if (!editor && keepsProgress) store.latest = { modeId, startId: activeStartId };
  store.lastLaunch = { modeId, editor, startId: activeStartId };
  writeStore(store);
}

/** Last session started, played or edited: { modeId, editor, startId }, or null. */
export const getLastLaunch = () => readStore().lastLaunch ?? null;

export const getActiveModeId = () => activeModeId;

/** The active game's start (e.g. 'rally', 'career'), or null in an editor / a mode without starts. */
export const getActiveStartId = () => activeStartId;

/** True when this session is the active mode's scenario editor. */
export const isEditorSession = () => editorSession;

/** A field of the active mode's slot; null before launch or when unset. */
export function readSaveField(field) {
  if (!activeModeId) return null;
  return readStore().modes[slotFor(field)]?.[field] ?? null;
}

export function writeSaveField(field, value) {
  if (!activeModeId) return;
  const store = readStore();
  const slot = (store.modes[slotFor(field)] ??= {});
  slot[field] = value;
  slot.savedAt = Date.now();
  writeStore(store);
}
