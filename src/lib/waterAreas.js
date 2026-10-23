// OSM water polygons (lakes, sea, wide rivers) - complements rivers.js's
// centerlines. The fill is a debug overlay (K key); classifyAt() always
// streams and drives splash.js. Plumbing is in vectorPolygonLayer.js.

import { createVectorPolygonLayer } from './vectorPolygonLayer.js';

// The water layer's maxzoom.
const WATER_TILE_ZOOM = 14;

// Below streets/rivers lift, so their lines draw over water.
const WATER_LIFT = 0.15;

// One blue for every water class.
const WATER_COLOR = 0x1e6fae;

// Water `class` values handled (others skipped).
const WATER_CLASSES = new Set(['ocean', 'lake', 'river', 'pond']);

function classifyWater(props) {
  const cls = props?.class;
  if (!WATER_CLASSES.has(cls)) return null;
  return { key: 'water', color: WATER_COLOR };
}

/** Streams water polygons (see header). */
export const WaterAreasManager = createVectorPolygonLayer({
  tileZoom: WATER_TILE_ZOOM,
  layerName: 'water',
  classify: classifyWater,
  lift: WATER_LIFT,
});
