// Named settlements (OpenMapTiles `place` layer) for direction signs: cities
// and towns from coarse tiles (a z8 tile is ~100 km), villages from z11 ones
// (the coarser zooms thin them out). Tiles load on demand around a query.

import { fetchVectorTileLayer } from './tiles/openFreeMap.js';
import { lon2tileX, lat2tileY, tileX2lon, tileY2lat } from './geo.js';

const LEVELS = [
  { zoom: 8, classes: new Set(['city', 'town']) },
  { zoom: 11, classes: new Set(['town', 'village']) },
];
const KEEP_TILES = 3; // around the car, per level; farther ones are dropped
const RETRY_MS = 10000;
const METERS_PER_DEGREE = 111_320;

function tileAt(zoom, lat, lon) {
  return { tx: Math.floor(lon2tileX(lon, zoom)), ty: Math.floor(lat2tileY(lat, zoom)) };
}

export function createPlaces() {
  const tiles = new Map(); // `${zoom}/${tx}/${ty}` -> { zoom, tx, ty, places | null (loading), failedAt }

  async function load(entry) {
    const { zoom, tx, ty } = entry;
    const { classes } = LEVELS.find((l) => l.zoom === zoom);
    try {
      const layer = await fetchVectorTileLayer(zoom, tx, ty, 'place');
      const places = [];
      for (let i = 0; i < (layer?.length ?? 0); i++) {
        const feature = layer.feature(i);
        const { class: cls, name, rank } = feature.properties;
        if (!classes.has(cls) || !name) continue;
        const p = feature.loadGeometry()[0]?.[0];
        if (!p) continue;
        places.push({
          name,
          cls,
          rank: rank ?? 99, // lower = more important
          lat: tileY2lat(ty + p.y / layer.extent, zoom),
          lon: tileX2lon(tx + p.x / layer.extent, zoom),
        });
      }
      entry.places = places;
    } catch (err) {
      console.warn('Place tile fetch failed, will retry', zoom, tx, ty, err);
      entry.failedAt = performance.now();
    }
  }

  /** Each level's 3x3 tiles around (lat, lon); starts missing fetches. */
  function around(lat, lon) {
    const out = [];
    for (const { zoom } of LEVELS) {
      const c = tileAt(zoom, lat, lon);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const key = `${zoom}/${c.tx + dx}/${c.ty + dy}`;
          let entry = tiles.get(key);
          if (!entry) tiles.set(key, (entry = { zoom, tx: c.tx + dx, ty: c.ty + dy, places: null, failedAt: 0 }));
          if (!entry.places && !entry.pending && (!entry.failedAt || performance.now() - entry.failedAt > RETRY_MS)) {
            entry.pending = load(entry).finally(() => (entry.pending = null));
          }
          out.push(entry);
        }
      }
    }
    return out;
  }

  return {
    /** Prefetches around the car and drops far tiles. */
    update(lat, lon) {
      around(lat, lon);
      for (const [key, entry] of tiles) {
        const c = tileAt(entry.zoom, lat, lon);
        if (Math.abs(entry.tx - c.tx) > KEEP_TILES || Math.abs(entry.ty - c.ty) > KEEP_TILES) tiles.delete(key);
      }
    },

    /**
     * Settlements around (lat, lon) with `dist` (m) and `east`/`north` (m) from it,
     * or null while tiles are still loading.
     */
    near(lat, lon) {
      const entries = around(lat, lon);
      if (entries.some((e) => !e.places)) return null;
      const byName = new Map(); // towns come from both levels
      const cosLat = Math.cos((lat * Math.PI) / 180);
      for (const e of entries) {
        for (const p of e.places) {
          const id = `${p.name}|${p.cls}`;
          if (byName.has(id)) continue;
          const north = (p.lat - lat) * METERS_PER_DEGREE;
          const east = (p.lon - lon) * METERS_PER_DEGREE * cosLat;
          byName.set(id, { ...p, north, east, dist: Math.hypot(north, east) });
        }
      }
      return Array.from(byName.values());
    },
  };
}
