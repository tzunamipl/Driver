import { findGroundY } from '../lib/terrain.js';
import { CAN_CHANGE_LOCATION } from '../config.js';
import { loadGameplayLayers } from '../app/gameplayLoad.js';

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
const TELEPORT_DAMAGE_GRACE_S = 3; // after the ease ends: the drop lands and the car settles
const TELEPORT_PROGRESS_INTERVAL_MS = 250;

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
 * @param {import('../lib/landcoverAreas.js').LandcoverAreasManager} [deps.landcoverAreas]
 * @param {import('./carManager.js').ReturnType} deps.carManager
 * @param {ReturnType<import('../app/viewFrame.js').createViewFrame>} deps.viewFrame - moved on teleport
 * @param {() => boolean} deps.isJoined
 */
export function createAddressSearch({ world, terrain, buildings, streets, rivers, waterAreas, builtUpAreas, landcoverAreas, carManager, viewFrame, isJoined }) {

  const addressStatusEl = document.getElementById('address-search-status');

  function setAddressStatus(text, isError = false) {
    addressStatusEl.textContent = text;
    addressStatusEl.style.display = text ? 'block' : 'none';
    addressStatusEl.classList.toggle('is-error', isError);
  }

  let teleporting = false;
  let quiet = false; // a teleport hidden by the caller: no status, no dissolve / orbit camera
  let isBlocked = () => false;

  // One teleport at a time.
  let teleportChain = Promise.resolve();

  async function teleportTo(lat, lon, label, hidden) {
    teleporting = true;
    quiet = hidden;
    const status = (text) => !hidden && setAddressStatus(text);
    // Live counts, so a stalled load shows where it stalled.
    const showTerrainProgress = () => {
      const p = terrain.getLoadProgress();
      status(`Loading terrain at new location\u2026 ${p.physicsLoaded} / ${p.physicsTotal} tiles`);
    };
    showTerrainProgress();
    const progressTimer = setInterval(showTerrainProgress, TELEPORT_PROGRESS_INTERVAL_MS);
    try {
      // Load terrain at the destination first, then reset() eases the car
      // there kinematically - it can't land on a missing chunk.
      try {
        await terrain.recenter(lat, lon);
      } finally {
        clearInterval(progressTimer);
      }
      status('Loading roads, water & buildings\u2026');
      buildings.recenter(lat, lon);
      if (streets) streets.recenter(lat, lon);
      if (rivers) rivers.recenter(lat, lon);
      if (waterAreas) waterAreas.recenter(lat, lon);
      if (builtUpAreas) builtUpAreas.recenter(lat, lon);
      if (landcoverAreas) landcoverAreas.recenter(lat, lon);
      viewFrame.set(lat, lon);
      const layers = [streets, rivers, waterAreas, builtUpAreas, landcoverAreas].filter(Boolean);
      await loadGameplayLayers({ buildings, layers }, lat, lon);
      // Position only, so the heading is kept. World y is relative to the
      // shared origin's elevation, so drop relative to the ground here.
      const groundY = findGroundY(world, 0, 0) ?? 0;
      const reset = carManager.getReset();
      carManager.protectFromDamage(TELEPORT_DAMAGE_GRACE_S);
      if (reset) reset({ x: 0, y: groundY + TELEPORT_DROP_HEIGHT, z: 0 });
      // Stay "teleporting" until the ease lands: it starts at the old spot's
      // stale coordinates, and streaming around it would drop the new ground.
      while (carManager.isResetting()) await new Promise(requestAnimationFrame);
      carManager.protectFromDamage(TELEPORT_DAMAGE_GRACE_S);
      if (!hidden) {
        setAddressStatus(`Teleported to ${label}`);
        setTimeout(() => setAddressStatus(''), 3000);
      }
    } finally {
      teleporting = false;
      quiet = false;
    }
  }

  /**
   * Queues a teleport; resolves true once the car is there, false if it failed or isn't allowed.
   * `quiet`: the caller hides it (e.g. a fade to black), so no status line and no teleport effects.
   */
  function teleport(lat, lon, label, { quiet: hidden = false } = {}) {
    if (!canTeleport()) return Promise.resolve(false);
    lon = ((((lon + 180) % 360) + 360) % 360) - 180; // a lon off the -180..180 range has no tiles: load would hang
    const run = teleportChain.then(() => teleportTo(lat, lon, label, hidden));
    teleportChain = run.catch((err) => {
      console.warn('Teleport failed', err);
      setAddressStatus(`Couldn't teleport: ${err.message}`, true);
    });
    return run.then(() => true, () => false);
  }

  function canTeleport() {
    return CAN_CHANGE_LOCATION && isJoined() && !teleporting && !isBlocked();
  }

  return {
    awaitOriginChain: () => teleportChain,
    // True during a teleport; mainLoop skips its own streaming meanwhile.
    isTeleporting: () => teleporting,
    // Teleport effects (dissolve, orbit camera) play; off for a quiet teleport.
    showsTeleportFx: () => teleporting && !quiet,
    canTeleport,
    teleport,
    /** Game-mode veto, e.g. during a rally stage. */
    setBlocked(fn) {
      isBlocked = fn;
    },
    geocode: geocodeAddress,
    reverseGeocode,
  };
}
