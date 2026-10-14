// OpenFreeMap vector tiles (keyless static CDN, OpenMapTiles schema):
// URL template lookup and fetch + decode of one tile layer.

import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

// TileJSON advertising the current (versioned) tile URL template.
const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const FETCH_TIMEOUT_MS = 15000;

let tileUrlTemplatePromise = null;
/** Tile URL template (memoized; retried after a failure). */
export async function getTileUrlTemplate() {
  if (!tileUrlTemplatePromise) {
    tileUrlTemplatePromise = fetch(TILEJSON_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`TileJSON request failed (${res.status})`);
        return res.json();
      })
      .then((json) => {
        const template = json?.tiles?.[0];
        if (!template) throw new Error('TileJSON response had no tiles[] entry');
        return template;
      })
      .catch((err) => {
        tileUrlTemplatePromise = null; // let the next attempt retry the TileJSON fetch itself
        throw err;
      });
  }
  return tileUrlTemplatePromise;
}

/**
 * Fetches tile (zoom, tx, ty) and returns its decoded `layerName` layer,
 * or null if the tile (404) or layer doesn't exist. Throws on other errors.
 */
export async function fetchVectorTileLayer(zoom, tx, ty, layerName) {
  const template = await getTileUrlTemplate();
  const url = template.replace('{z}', zoom).replace('{x}', tx).replace('{y}', ty);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let buffer;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 404) return null; // no data, not an error
    if (!res.ok) throw new Error(`Tile request failed (${res.status})`);
    buffer = await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }

  const tile = new VectorTile(new PbfReader(new Uint8Array(buffer)));
  return tile.layers[layerName] ?? null;
}
