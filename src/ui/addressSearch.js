import { lon2tileX, lat2tileY } from '../lib/geo.js';
import { DETAIL_ZOOM, findGroundY } from '../lib/terrain.js';
import { CAN_CHANGE_LOCATION } from '../config.js';

// Address search + personal teleport via Nominatim (keyless). Purely
// local: recentres this browser's streaming and moves only this car; the
// network origin (config.js) never changes.

const NOMINATIM_URL = (q) =>
  `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;

// Drop-in height above the destination ground (same as the initial spawn).
const TELEPORT_DROP_HEIGHT = 3;

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
 * @param {import('cannon-es').World} deps.world
 * @param {import('../lib/terrain.js').TerrainManager} deps.terrain
 * @param {import('../lib/buildings.js').BuildingsManager} deps.buildings
 * @param {import('../lib/streets.js').StreetsManager} [deps.streets]
 * @param {import('../lib/rivers.js').RiversManager} [deps.rivers]
 * @param {import('../lib/waterAreas.js').WaterAreasManager} [deps.waterAreas]
 * @param {import('./carManager.js').ReturnType} deps.carManager
 * @param {ReturnType<import('../app/viewFrame.js').createViewFrame>} deps.viewFrame - moved on teleport
 * @param {() => boolean} deps.isJoined
 */
export function createAddressSearch({ world, terrain, buildings, streets, rivers, waterAreas, carManager, viewFrame, isJoined }) {

  const addressForm = document.getElementById('address-search');
  const addressToggle = document.getElementById('address-search-toggle');
  const addressInput = document.getElementById('address-input');
  const addressSubmit = document.getElementById('address-submit');
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

  // One teleport at a time.
  let teleportChain = Promise.resolve();

  async function teleportTo(lat, lon, query) {
    teleporting = true;
    addressSubmit.disabled = true;
    setAddressStatus('Loading terrain at new location\u2026');
    try {
      // Load terrain at the destination first, then reset() eases the car
      // there kinematically - it can't land on a missing chunk.
      await terrain.recenter(lat, lon);
      buildings.recenter(lat, lon);
      if (streets) streets.recenter(lat, lon);
      if (rivers) rivers.recenter(lat, lon);
      if (waterAreas) waterAreas.recenter(lat, lon);
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
      // Position only, so the heading is kept. World y is relative to the
      // shared origin's elevation, so drop relative to the ground here.
      const groundY = findGroundY(world, 0, 0) ?? 0;
      const reset = carManager.getReset();
      if (reset) reset({ x: 0, y: groundY + TELEPORT_DROP_HEIGHT, z: 0 });
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
    awaitOriginChain: () => teleportChain,
    // True during a teleport; mainLoop skips its own streaming meanwhile.
    isTeleporting: () => teleporting,
    setUiEnabled(enabled) {
      addressInput.disabled = !enabled || !CAN_CHANGE_LOCATION;
      addressSubmit.disabled = !enabled || !CAN_CHANGE_LOCATION;
    },
  };
}
