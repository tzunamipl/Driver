import { lon2tileX, lat2tileY } from '../lib/geo.js';
import { DETAIL_ZOOM, findGroundY } from '../lib/terrain.js';
import { CAN_CHANGE_LOCATION } from '../config.js';

// Geocoding + personal teleport via Nominatim (keyless); the UI lives in
// navigationPanel.js. Purely local: recentres this browser's streaming and
// moves only this car; the network origin (config.js) never changes.

const SEARCH_LIMIT = 5;
const NOMINATIM_SEARCH_URL = (q) =>
  `https://nominatim.openstreetmap.org/search?format=json&limit=${SEARCH_LIMIT}&q=${encodeURIComponent(q)}`;
const NOMINATIM_REVERSE_URL = (lat, lon) =>
  `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16`;

// Drop-in height above the destination ground (same as the initial spawn).
const TELEPORT_DROP_HEIGHT = 3;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`geocoding request failed (${res.status})`);
  return res.json();
}

/** Up to SEARCH_LIMIT matches: { lat, lon, label, bbox: [south, north, west, east] | null }. */
async function geocodeAddress(query) {
  const results = await fetchJson(NOMINATIM_SEARCH_URL(query));
  if (!results.length) throw new Error('address not found');
  return results.map((r) => ({
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    label: r.display_name,
    bbox: r.boundingbox?.length === 4 ? r.boundingbox.map(Number) : null,
  }));
}

/** Place name at a point, or null. */
async function reverseGeocode(lat, lon) {
  const data = await fetchJson(NOMINATIM_REVERSE_URL(lat, lon));
  return data?.display_name ?? null;
}

/**
 * @param {object} deps
 * @param {import('cannon-es').World} deps.world
 * @param {import('../lib/terrain.js').TerrainManager} deps.terrain
 * @param {import('../lib/buildings.js').BuildingsManager} deps.buildings
 * @param {import('../lib/streets.js').StreetsManager} [deps.streets]
 * @param {import('../lib/rivers.js').RiversManager} [deps.rivers]
 * @param {import('../lib/waterAreas.js').WaterAreasManager} [deps.waterAreas]
 * @param {import('../lib/builtUpAreas.js').BuiltUpAreasManager} [deps.builtUpAreas]
 * @param {import('../lib/forestAreas.js').ForestAreasManager} [deps.forestAreas]
 * @param {import('./carManager.js').ReturnType} deps.carManager
 * @param {ReturnType<import('../app/viewFrame.js').createViewFrame>} deps.viewFrame - moved on teleport
 * @param {() => boolean} deps.isJoined
 */
export function createAddressSearch({ world, terrain, buildings, streets, rivers, waterAreas, builtUpAreas, forestAreas, carManager, viewFrame, isJoined }) {

  const addressStatusEl = document.getElementById('address-search-status');

  function setAddressStatus(text, isError = false) {
    addressStatusEl.textContent = text;
    addressStatusEl.style.display = text ? 'block' : 'none';
    addressStatusEl.style.color = isError ? '#ff8080' : '#fff';
  }

  let teleporting = false;

  // One teleport at a time.
  let teleportChain = Promise.resolve();

  async function teleportTo(lat, lon, label) {
    teleporting = true;
    setAddressStatus('Loading terrain at new location\u2026');
    try {
      // Load terrain at the destination first, then reset() eases the car
      // there kinematically - it can't land on a missing chunk.
      await terrain.recenter(lat, lon);
      buildings.recenter(lat, lon);
      if (streets) streets.recenter(lat, lon);
      if (rivers) rivers.recenter(lat, lon);
      if (waterAreas) waterAreas.recenter(lat, lon);
      if (builtUpAreas) builtUpAreas.recenter(lat, lon);
      if (forestAreas) forestAreas.recenter(lat, lon);
      viewFrame.set(lat, lon);
      await buildings.update(
        Math.floor(lon2tileX(lon, DETAIL_ZOOM)),
        Math.floor(lat2tileY(lat, DETAIL_ZOOM)),
        true
      );
      if (streets) {
        await streets.update(
          Math.floor(lon2tileX(lon, DETAIL_ZOOM)),
          Math.floor(lat2tileY(lat, DETAIL_ZOOM)),
          true
        );
      }
      if (rivers) {
        await rivers.update(
          Math.floor(lon2tileX(lon, DETAIL_ZOOM)),
          Math.floor(lat2tileY(lat, DETAIL_ZOOM)),
          true
        );
      }
      if (waterAreas) {
        await waterAreas.update(
          Math.floor(lon2tileX(lon, DETAIL_ZOOM)),
          Math.floor(lat2tileY(lat, DETAIL_ZOOM)),
          true
        );
      }
      if (builtUpAreas) {
        await builtUpAreas.update(
          Math.floor(lon2tileX(lon, DETAIL_ZOOM)),
          Math.floor(lat2tileY(lat, DETAIL_ZOOM)),
          true
        );
      }
      // Position only, so the heading is kept. World y is relative to the
      // shared origin's elevation, so drop relative to the ground here.
      const groundY = findGroundY(world, 0, 0) ?? 0;
      const reset = carManager.getReset();
      if (reset) reset({ x: 0, y: groundY + TELEPORT_DROP_HEIGHT, z: 0 });
      setAddressStatus(`Teleported to ${label}`);
      setTimeout(() => setAddressStatus(''), 3000);
    } finally {
      teleporting = false;
    }
  }

  /** Queues a teleport; resolves true once the car is there, false if it failed or isn't allowed. */
  function teleport(lat, lon, label) {
    if (!canTeleport()) return Promise.resolve(false);
    const run = teleportChain.then(() => teleportTo(lat, lon, label));
    teleportChain = run.catch((err) => {
      console.warn('Teleport failed', err);
      setAddressStatus(`Couldn't teleport: ${err.message}`, true);
    });
    return run.then(() => true, () => false);
  }

  function canTeleport() {
    return CAN_CHANGE_LOCATION && isJoined() && !teleporting;
  }

  return {
    awaitOriginChain: () => teleportChain,
    // True during a teleport; mainLoop skips its own streaming meanwhile.
    isTeleporting: () => teleporting,
    canTeleport,
    teleport,
    geocode: geocodeAddress,
    reverseGeocode,
  };
}
