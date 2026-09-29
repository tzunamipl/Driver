// Persistent (IndexedDB) local cache for OSM building footprints, so that
// once a tile's buildings have been fetched from Overpass at least once,
// they keep showing up on future visits even if Overpass is temporarily
// unreachable (it's a free, best-effort public API with no uptime
// guarantee - see the long comment atop buildings.js). This is purely a
// fallback data source: BuildingsManager always prefers a fresh network
// fetch, and only reads from here when that fetch fails outright.
//
// Keyed by the same absolute Web Mercator tile coordinates (z/tx/ty) used
// to bucket buildings in buildings.js - those are independent of wherever
// the car's local-origin currently is, so cached tiles remain valid across
// recenter()s and app restarts alike.

const DB_NAME = 'driver-buildings-cache';
const DB_VERSION = 1;
const STORE = 'tiles';

// Rough cap on how many tiles' worth of building data we keep on disk
// indefinitely - without this, driving around a lot over many sessions
// would grow IndexedDB usage without bound. When exceeded, the oldest
// (by last-written time) entries are trimmed. Generous enough to cover a
// large driving session's worth of tiles.
const MAX_CACHED_TILES = 20000;
const TRIM_TO_TILES = 18000; // trim down to this many when the cap is hit, so trimming isn't triggered every single write

function tileKey(zoom, tx, ty) {
  return `${zoom}_${tx}_${ty}`;
}

let dbPromise = null;

/** Lazily opens (and upgrades) the database. Resolves to null if IndexedDB isn't available (older browsers, private-mode restrictions, etc.) - callers treat that as "cache disabled". */
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      console.warn('Buildings cache: failed to open IndexedDB', err);
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('savedAt', 'savedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.warn('Buildings cache: IndexedDB open failed', request.error);
      resolve(null);
    };
  });
  return dbPromise;
}

/**
 * Writes a batch of freshly-fetched tiles' building lists to the cache.
 * Fire-and-forget from the caller's perspective (returns a promise but
 * failures are swallowed - a cache write failing should never affect
 * live rendering).
 */
export async function cacheTiles(zoom, byTile) {
  try {
    const db = await openDb();
    if (!db || byTile.size === 0) return;

    const savedAt = Date.now();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const [key, list] of byTile) {
        store.put({ key: `${zoom}_${key}`, buildings: list, savedAt });
      }
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });

    await trimIfNeeded(db);
  } catch (err) {
    console.warn('Buildings cache: write failed', err);
  }
}

/** Deletes the oldest cached tiles once the store grows past MAX_CACHED_TILES. */
async function trimIfNeeded(db) {
  try {
    const count = await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (count <= MAX_CACHED_TILES) return;

    const toDelete = count - TRIM_TO_TILES;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const index = tx.objectStore(STORE).index('savedAt');
      let deleted = 0;
      const cursorReq = index.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || deleted >= toDelete) return;
        cursor.delete();
        deleted++;
        cursor.continue();
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('Buildings cache: trim failed', err);
  }
}

/**
 * Reads every cached tile within [minTx..maxTx] x [minTy..maxTy] at the
 * given zoom. Used as a fallback when a live region fetch fails outright,
 * so previously-seen buildings still render instead of the area staying
 * empty. Returns a Map<tileKey, buildingList> (buildingList entries shaped
 * like { ring, height }, same as a live fetch produces) - empty if the
 * cache is unavailable or nothing was found.
 */
export async function readCachedRegion(zoom, minTx, maxTx, minTy, maxTy) {
  const result = new Map();
  try {
    const db = await openDb();
    if (!db) return result;

    const keys = [];
    for (let tx = minTx; tx <= maxTx; tx++) {
      for (let ty = minTy; ty <= maxTy; ty++) {
        keys.push({ tx, ty, key: tileKey(zoom, tx, ty) });
      }
    }

    await new Promise((resolve) => {
      const dbTx = db.transaction(STORE, 'readonly');
      const store = dbTx.objectStore(STORE);
      let remaining = keys.length;
      if (remaining === 0) {
        resolve();
        return;
      }
      for (const { tx, ty, key } of keys) {
        const req = store.get(key);
        req.onsuccess = () => {
          if (req.result) result.set(`${tx}_${ty}`, req.result.buildings);
          if (--remaining === 0) resolve();
        };
        req.onerror = () => {
          if (--remaining === 0) resolve();
        };
      }
    });
  } catch (err) {
    console.warn('Buildings cache: read failed', err);
  }
  return result;
}
