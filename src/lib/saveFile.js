import { SAVE_IMPORT_STORAGE_KEY, LEGACY_GITHUB_TOKEN_STORAGE_KEY, LEGACY_CLOUD_SAVE_STORAGE_KEY, ROSTER_STORAGE_KEY } from '../config.js';

// Save export / import: every `driver.*` localStorage key (save slots, profile, odometers, bests,
// settings, player id) in one JSON file; other players' data (the roster) stays out. An import is applied on the next load, before anything
// reads storage, so this page's pagehide saves can't overwrite it.

const PREFIX = 'driver.';
const FORMAT = 'driver-save';
const VERSION = 1;
const SKIP = new Set([LEGACY_GITHUB_TOKEN_STORAGE_KEY, LEGACY_CLOUD_SAVE_STORAGE_KEY, ROSTER_STORAGE_KEY]);

const ownKeys = () => Object.keys(localStorage).filter((key) => key.startsWith(PREFIX) && !SKIP.has(key));

/** Downloads the save file. */
export function exportSaveFile() {
  const data = {};
  for (const key of ownKeys()) data[key] = localStorage.getItem(key);
  const file = { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), data };
  const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `driver-save-${new Date().toISOString().slice(0, 10)}.json` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Checks a picked file and queues it for the next load; throws with a player-facing message. */
export async function queueSaveImport(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('Not a save file');
  }
  if (parsed?.format !== FORMAT || !parsed.data || typeof parsed.data !== 'object') throw new Error('Not a save file');
  if (parsed.version > VERSION) throw new Error('Save file from a newer game version');
  const entries = Object.entries(parsed.data).filter(([key]) => !SKIP.has(key));
  if (entries.some(([key, value]) => !key.startsWith(PREFIX) || typeof value !== 'string')) throw new Error('Damaged save file');
  sessionStorage.setItem(SAVE_IMPORT_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
}

/** Replaces this browser's data with a queued import, if any. Call before anything reads storage. */
export function applyQueuedSaveImport() {
  try {
    const queued = sessionStorage.getItem(SAVE_IMPORT_STORAGE_KEY);
    sessionStorage.removeItem(SAVE_IMPORT_STORAGE_KEY);
    if (!queued) return;
    const data = JSON.parse(queued);
    for (const key of ownKeys()) localStorage.removeItem(key);
    for (const [key, value] of Object.entries(data)) localStorage.setItem(key, value);
  } catch (err) {
    console.warn('Save import:', err.message);
  }
}
