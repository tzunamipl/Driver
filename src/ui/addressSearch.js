import { lon2tileX, lat2tileY } from '../lib/geo.js';
import { DETAIL_ZOOM } from '../lib/terrain.js';
import { CAN_CHANGE_LOCATION } from '../config.js';

// Address search / personal teleport flow: free, keyless geocoding via
// OpenStreetMap's Nominatim (matching the project's "no API keys"
// philosophy - see README), re-centering *this browser's own* terrain/
// buildings streaming around the result, and moving *only this player's*
// car there.
//
// This is deliberately per-player and entirely local: nothing here is
// published over the network, so it can never move another player's car,
// change what anyone else's world looks like, or shift the shared spawn
// point new joiners land at (see config.js's ORIGIN_LAT/ORIGIN_LON, which
// stay fixed forever as the "network origin" every pose is encoded
// against - see geo.js's remapLocalOrigin and app/mainLoop.js for how the
// two origins are kept from colliding once they diverge). Isolated from
// the main loop/lobby since it's entirely its own request/response + DOM-
// form flow.

const NOMINATIM_URL = (q) =>
  `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;

// Where the car lands (in the new local frame) after a teleport - same
// small drop-in height as the initial spawn, so gravity settles it onto
// the real ground once the destination's physics chunk has loaded.
const TELEPORT_LOCAL_POS = { x: 0, y: 3, z: 0 };

async function geocodeAddress(query) {
  const res = await fetch(NOMINATIM_URL(query), {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`geocoding request failed (${res.status})`);
  const results = await res.json();
  if (!results.length) throw new Error('address not found');
  return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
}

/**
 * @param {object} deps
 * @param {import('../lib/terrain.js').TerrainManager} deps.terrain
 * @param {import('../lib/buildings.js').BuildingsManager} deps.buildings
 * @param {import('./carManager.js').ReturnType} deps.carManager
 * @param {{lat: number, lon: number}} deps.origin - initial spawn origin
 * @param {() => boolean} deps.isJoined
 */
export function createAddressSearch({ terrain, buildings, carManager, origin, isJoined }) {
  // Tracks whichever lat/lon this player's own local (0, 0) origin
  // currently represents - starts at `origin` (the shared network origin)
  // but is repointed whenever *this* player teleports elsewhere. Read
  // every frame by the main loop for building-tile streaming, the
  // minimap, and remapping remote poses into this player's local frame
  // (see geo.js's remapLocalOrigin).
  let currentOriginLat = origin.lat;
  let currentOriginLon = origin.lon;

  const addressForm = document.getElementById('address-search');
  const addressToggle = document.getElementById('address-search-toggle');
  const addressInput = document.getElementById('address-input');
  const addressSubmit = document.getElementById('address-submit');
  // Hide the teleport UI entirely (rather than merely disabling it) when
  // location changes are disallowed altogether.
  if (!CAN_CHANGE_LOCATION) {
    addressForm.style.display = 'none';
    if (addressToggle) addressToggle.style.display = 'none';
  }
  // On a phone the search field stays folded under this button until tapped.
  addressToggle?.addEventListener('click', () => {
    const open = addressForm.classList.toggle('is-open');
    addressToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) addressInput.focus();
  });
  const addressStatusEl = document.getElementById('address-search-status');

  function setAddressStatus(text, isError = false) {
    addressStatusEl.textContent = text;
    addressStatusEl.style.display = text ? 'block' : 'none';
    addressStatusEl.style.color = isError ? '#ff8080' : '#fff';
  }

  let teleporting = false;
  addressInput.disabled = true;
  addressSubmit.disabled = true;

  // Serializes teleport requests so a second submit can't kick off a
  // recenter while a previous one is still streaming in.
  let teleportChain = Promise.resolve();

  async function teleportTo(lat, lon, query) {
    teleporting = true;
    addressSubmit.disabled = true;
    setAddressStatus('Loading terrain at new location\u2026');
    try {
      // Recenter this player's own terrain/buildings streaming around the
      // destination *before* moving the car - by the time this resolves,
      // real ground is already loaded at (0, 0) in the new local frame, so
      // reset() below never drops the car onto an unloaded/missing chunk.
      // reset() also eases the car onto its target pose via a brief
      // kinematic (gravity-immune) lift rather than snapping/dropping it,
      // as extra insurance against ever falling through the ground.
      await terrain.recenter(lat, lon);
      buildings.recenter(lat, lon);
      currentOriginLat = lat;
      currentOriginLon = lon;
      await buildings.update(
        Math.floor(lon2tileX(lon, DETAIL_ZOOM)),
        Math.floor(lat2tileY(lat, DETAIL_ZOOM)),
        true
      );
      // Only override position - omit the quaternion so reset() keeps the
      // car's current heading instead of snapping it back to the default
      // facing direction.
      const reset = carManager.getReset();
      if (reset) reset(TELEPORT_LOCAL_POS);
      setAddressStatus(`Teleported to "${query}"`);
      setTimeout(() => setAddressStatus(''), 3000);
    } finally {
      teleporting = false;
      addressSubmit.disabled = !isJoined() || !CAN_CHANGE_LOCATION;
    }
  }

  addressForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!CAN_CHANGE_LOCATION) return;
    const query = addressInput.value.trim();
    if (!query || teleporting || !isJoined()) return;

    addressSubmit.disabled = true;
    setAddressStatus(`Searching for "${query}"\u2026`);

    const run = teleportChain.then(async () => {
      const { lat, lon } = await geocodeAddress(query);
      await teleportTo(lat, lon, query);
    });
    teleportChain = run.catch((err) => {
      console.warn('Address teleport failed', err);
      setAddressStatus(`Couldn't teleport: ${err.message}`, true);
    });
    await teleportChain;
    addressSubmit.disabled = !isJoined() || !CAN_CHANGE_LOCATION;
  });

  return {
    getCurrentOrigin: () => ({ lat: currentOriginLat, lon: currentOriginLon }),
    awaitOriginChain: () => teleportChain,
    // True from the moment terrain.recenter() starts until the car has
    // been dropped at its destination - see mainLoop.js, which skips its
    // own per-frame terrain/buildings streaming calls during this window
    // to avoid racing recenter()'s own streaming with stale car coordinates.
    isTeleporting: () => teleporting,
    setUiEnabled(enabled) {
      addressInput.disabled = !enabled || !CAN_CHANGE_LOCATION;
      addressSubmit.disabled = !enabled || !CAN_CHANGE_LOCATION;
    },
  };
}
