import {
  CAN_USE_NETWORK,
  LEADERBOARD_URL,
  SAVES_STORAGE_KEY,
  LOBBY_STORAGE_KEY,
  VEHICLE_ODOMETERS_STORAGE_KEY,
  CLOUD_SAVE_STORAGE_KEY,
  CLOUD_SAVE_INTERVAL_MS,
  CLOUD_SAVE_MIN_GAP_MS,
  CLOUD_SAVE_RESTORE_TIMEOUT_MS,
} from '../config.js';

// Backup of the player's save slots (incl. distance driven), profile and per-car odometers in the
// worker's data repo, keyed by the player id. At launch the newer copy wins; while playing, changes
// are pushed every CLOUD_SAVE_INTERVAL_MS, on menu open and when the page is hidden.

const KEYS = [SAVES_STORAGE_KEY, LOBBY_STORAGE_KEY, VEHICLE_ODOMETERS_STORAGE_KEY];

const enabled = CAN_USE_NETWORK && !!LEADERBOARD_URL;

function readLocal() {
  const data = {};
  try {
    for (const key of KEYS) data[key] = localStorage.getItem(key);
  } catch {
    // Storage unavailable: nothing to back up.
  }
  return data;
}

function readMeta() {
  try {
    return JSON.parse(localStorage.getItem(CLOUD_SAVE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeMeta(meta) {
  try {
    localStorage.setItem(CLOUD_SAVE_STORAGE_KEY, JSON.stringify(meta));
  } catch {}
}

// FNV-1a: only tells "changed since the last look".
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

/** Local data + its meta, with updatedAt bumped when the data changed since the last look. */
function look() {
  const data = readLocal();
  const h = hash(JSON.stringify(data));
  const meta = readMeta() ?? { hash: null, updatedAt: 0, pushedAt: 0 };
  if (meta.hash !== h) {
    meta.hash = h;
    meta.updatedAt = Date.now();
    writeMeta(meta);
  }
  return { data, meta };
}

async function api(path, body, signal) {
  const res = await fetch(`${LEADERBOARD_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `Cloud save ${res.status}`);
  return json;
}

/**
 * Brings back the remote copy when it's newer than this browser's, else backs this one up.
 * Resolves within CLOUD_SAVE_RESTORE_TIMEOUT_MS either way; never throws.
 */
export async function restoreCloudSave(playerId) {
  if (!enabled) return;
  // Never synced from this browser: whatever is stored remotely is the newer copy.
  const synced = !!readMeta();
  const { data, meta } = look();
  const localAt = synced ? meta.updatedAt : 0;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CLOUD_SAVE_RESTORE_TIMEOUT_MS);
  try {
    const { save } = await api('/player/load', { playerId }, abort.signal);
    if (save && save.updatedAt > localAt) {
      for (const key of KEYS) {
        const value = save.data?.[key];
        if (typeof value === 'string') localStorage.setItem(key, value);
        else localStorage.removeItem(key);
      }
      writeMeta({ hash: hash(JSON.stringify(readLocal())), updatedAt: save.updatedAt, pushedAt: save.updatedAt });
    } else if (!save && meta.pushedAt && Object.values(data).some((v) => v != null)) {
      writeMeta({ ...meta, pushedAt: 0 }); // backup gone: push again
    }
  } catch (err) {
    console.warn('Cloud save restore:', err.message);
  } finally {
    clearTimeout(timer);
  }
}

/** Starts the periodic backup; returns { push } for a push now (throttled by CLOUD_SAVE_MIN_GAP_MS). */
export function createCloudSave(playerId) {
  if (!enabled) return { push() {} };
  let lastPush = 0;
  let sending = false;

  async function push(force = false) {
    const now = Date.now();
    if (sending || (!force && now - lastPush < CLOUD_SAVE_MIN_GAP_MS)) return;
    const { data, meta } = look();
    if (meta.pushedAt >= meta.updatedAt) return;
    lastPush = now;
    sending = true;
    try {
      await api('/player/save', { playerId, updatedAt: meta.updatedAt, data });
      writeMeta({ ...readMeta(), pushedAt: meta.updatedAt });
    } catch (err) {
      console.warn('Cloud save:', err.message);
    } finally {
      sending = false;
    }
  }

  /** Page going away: a beacon, as fetch may be cut off. text/plain keeps it a simple CORS request. */
  function pushBeacon() {
    const { data, meta } = look();
    if (meta.pushedAt >= meta.updatedAt) return;
    const body = new Blob([JSON.stringify({ playerId, updatedAt: meta.updatedAt, data })], { type: 'text/plain' });
    if (navigator.sendBeacon(`${LEADERBOARD_URL}/player/save`, body)) writeMeta({ ...meta, pushedAt: meta.updatedAt });
  }

  setInterval(() => push(true), CLOUD_SAVE_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') pushBeacon();
  });
  return { push: () => push() };
}
