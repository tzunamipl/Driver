// Gameplay tier of a load (after terrain): the overlay data behind tyre grip and
// splash, and the near buildings' collision prisms. Cosmetics stream in afterwards.

import { lon2tileX, lat2tileY } from '../lib/geo.js';
import { DETAIL_ZOOM } from '../lib/terrain.js';

// A slow data server shouldn't hold the game: past this it all keeps streaming in play.
const GAMEPLAY_LOAD_TIMEOUT_MS = 20_000;

/** Resolves once `layers` (overlay managers) hold data around (lat, lon) and `buildings` are built there, or on timeout. */
export function loadGameplayLayers({ buildings, layers }, lat, lon) {
  const tx = Math.floor(lon2tileX(lon, DETAIL_ZOOM));
  const ty = Math.floor(lat2tileY(lat, DETAIL_ZOOM));
  const loads = Promise.allSettled([...layers.map((layer) => layer.update(tx, ty, true)), buildings.update(tx, ty, true)]);
  const timeout = new Promise((resolve) => setTimeout(resolve, GAMEPLAY_LOAD_TIMEOUT_MS));
  return Promise.race([loads, timeout]);
}
