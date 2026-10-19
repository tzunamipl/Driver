// OSM Standard raster tiles (keyless; attribution required by OSM policy),
// shared by the minimap and the navigation map.

export const TILE_SIZE = 256;
// Legacy subdomains are allowed by OSM's tile policy.
const MAP_SUBDOMAINS = ['a', 'b', 'c'];
const mapTileUrl = (z, x, y) =>
  `https://${MAP_SUBDOMAINS[(x + y) % MAP_SUBDOMAINS.length]}.tile.openstreetmap.org/${z}/${x}/${y}.png`;

function loadTileImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // OSM tiles send CORS headers, so the canvas stays untainted.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

export function formatCoords(lat, lon) {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lonDir = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}°${latDir} ${Math.abs(lon).toFixed(5)}°${lonDir}`;
}

/** Bounded "z/x/y" -> { img, ready, failed } cache; `get` starts the load on a miss. */
export function createMapTileCache({ maxSize = 600, pruneTo = 400 } = {}) {
  const cache = new Map();
  return {
    get(z, x, y) {
      const n = 2 ** z;
      // Wrap x across the antimeridian (y doesn't wrap).
      const wrappedX = ((x % n) + n) % n;
      if (y < 0 || y >= n) return null;
      const key = `${z}/${wrappedX}/${y}`;
      let entry = cache.get(key);
      if (!entry) {
        entry = { img: null, ready: false, failed: false };
        cache.set(key, entry);
        loadTileImage(mapTileUrl(z, wrappedX, y))
          .then((img) => {
            entry.img = img;
            entry.ready = true;
          })
          .catch(() => {
            entry.failed = true;
          });
      }
      return entry;
    },
    prune() {
      if (cache.size <= maxSize) return;
      let toDrop = cache.size - pruneTo;
      for (const key of cache.keys()) {
        if (toDrop-- <= 0) break;
        cache.delete(key);
      }
    },
  };
}
