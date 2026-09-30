import { lon2tileX, lat2tileY } from '../lib/geo.js';
import { DETAIL_ZOOM } from '../lib/terrain.js';
import { CAN_CHANGE_LOCATION } from '../config.js';

// Address search / respawn-elsewhere flow: free, keyless geocoding via
// OpenStreetMap's Nominatim (matching the project's "no API keys"
// philosophy - see README), re-centering the terrain/buildings streaming
// systems on the result, and teleporting the car there. In the shared room
// the new origin is published (retained) so everyone else recenters and
// respawns on the same map. Isolated from the main loop/lobby since it's
// entirely its own request/response + DOM-form flow.

const NOMINATIM_URL = (q) =>
  `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;

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
 * @param {ReturnType<typeof import('../lib/net.js').createNet>} deps.net
 * @param {import('./carManager.js').ReturnType} deps.carManager
 * @param {{lat: number, lon: number}} deps.origin - initial spawn origin
 * @param {import('cannon-es').Vec3} deps.startPos
 * @param {import('cannon-es').Quaternion} deps.startQuat
 * @param {() => boolean} deps.isJoined
 */
export function createAddressSearch({ terrain, buildings, net, carManager, origin, startPos, startQuat, isJoined, playerSpawnPos }) {
  // Tracks whichever lat/lon the local (0,0) origin currently represents -
  // starts at `origin` but is repointed whenever the car respawns
  // elsewhere. Needed by the main loop to convert the car's local position
  // back to lat/lon for building-tile streaming after a respawn.
  let currentOriginLat = origin.lat;
  let currentOriginLon = origin.lon;

  const addressForm = document.getElementById('address-search');
  const addressInput = document.getElementById('address-input');
  const addressSubmit = document.getElementById('address-submit');
  // Prod players' location is fixed - hide the respawn-elsewhere UI
  // entirely instead of merely disabling it.
  if (!CAN_CHANGE_LOCATION) addressForm.style.display = 'none';
  const addressStatusEl = document.getElementById('address-search-status');

  function setAddressStatus(text, isError = false) {
    addressStatusEl.textContent = text;
    addressStatusEl.style.display = text ? 'block' : 'none';
    addressStatusEl.style.color = isError ? '#ff8080' : '#fff';
  }

  let respawning = false;
  addressInput.disabled = true;
  addressSubmit.disabled = true;

  let originChain = Promise.resolve();

  async function goToOrigin(lat, lon, { resetCar, announce }) {
    const same =
      Math.abs(lat - currentOriginLat) < 1e-7 &&
      Math.abs(lon - currentOriginLon) < 1e-7;
    if (!same) {
      respawning = true;
      addressSubmit.disabled = true;
      setAddressStatus('Loading terrain at new location\u2026');
      try {
        await terrain.recenter(lat, lon);
        buildings.recenter(lat, lon);
        currentOriginLat = lat;
        currentOriginLon = lon;
        await buildings.update(
          Math.floor(lon2tileX(lon, DETAIL_ZOOM)),
          Math.floor(lat2tileY(lat, DETAIL_ZOOM)),
          true
        );
        setAddressStatus('');
      } finally {
        respawning = false;
        addressSubmit.disabled = !isJoined() || !CAN_CHANGE_LOCATION;
      }
    }
    const reset = carManager.getReset();
    if (reset && resetCar && (!same || announce)) reset(playerSpawnPos(), startQuat);
    if (announce && !same) net.publishOrigin(lat, lon);
  }

  function enqueueOrigin(lat, lon, options) {
    const run = originChain.then(() => goToOrigin(lat, lon, options));
    originChain = run.catch((err) => {
      console.warn('Shared origin failed', err);
      setAddressStatus(`Couldn't respawn: ${err.message}`, true);
    });
    return run;
  }

  net.onOrigin(({ lat, lon }) => {
    // Prod players' location is fixed even if a dev-mode peer in the same
    // shared room broadcasts an origin change - ignore it rather than
    // teleporting along with them.
    if (!CAN_CHANGE_LOCATION) return;
    enqueueOrigin(lat, lon, { resetCar: true, announce: false });
  });

  addressForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!CAN_CHANGE_LOCATION) return;
    const query = addressInput.value.trim();
    if (!query || respawning || !isJoined()) return;

    addressSubmit.disabled = true;
    setAddressStatus(`Searching for "${query}"\u2026`);

    try {
      const { lat, lon } = await geocodeAddress(query);
      await enqueueOrigin(lat, lon, { resetCar: true, announce: true });
      setAddressStatus('Loading terrain at new location\u2026');
      await terrain.recenter(lat, lon);
      buildings.recenter(lat, lon);
      currentOriginLat = lat;
      currentOriginLon = lon;
      await buildings.update(
        Math.floor(lon2tileX(lon, DETAIL_ZOOM)),
        Math.floor(lat2tileY(lat, DETAIL_ZOOM)),
        true
      );
      // Only override position (new spawn location) - omit the quaternion
      // so reset() keeps the car's current heading instead of snapping it
      // back to the default facing direction.
      const reset = carManager.getReset();
      if (reset) reset(startPos);
      setAddressStatus(`Respawned at "${query}"`);
      setTimeout(() => setAddressStatus(''), 3000);
    } catch (err) {
      console.warn('Address respawn failed', err);
      setAddressStatus(`Couldn't respawn: ${err.message}`, true);
    } finally {
      addressSubmit.disabled = false;
    }
  });

  return {
    getCurrentOrigin: () => ({ lat: currentOriginLat, lon: currentOriginLon }),
    awaitOriginChain: () => originChain,
    setUiEnabled(enabled) {
      addressInput.disabled = !enabled || !CAN_CHANGE_LOCATION;
      addressSubmit.disabled = !enabled || !CAN_CHANGE_LOCATION;
    },
  };
}
