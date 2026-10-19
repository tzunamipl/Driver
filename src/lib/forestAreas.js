// OSM forest (landcover `wood`) polygons - classifyAt() drives the forest
// tyre-grip surface and trees.js; the fill is a debug overlay. The terrain
// worker reads the same layer for the forest floor (terrain/forestFloor.js).
// Plumbing is in vectorPolygonLayer.js.

import { createVectorPolygonLayer } from './vectorPolygonLayer.js';
import { FOREST_LANDCOVER_ZOOM, FOREST_LANDCOVER_CLASSES } from './terrain/forestFloor.js';
import { HIGH_DETAIL_RADIUS, UNLOAD_MARGIN } from './terrain.js';
import { TREE_DRAW_DISTANCE_M } from '../config.js';

// Below built-up and water, so both still read on top.
const FOREST_LIFT = 0.05;
const FOREST_OPACITY = 0.3;
const FOREST_COLOR = 0x2e7d32;

// Narrowest DETAIL_ZOOM tile the game meets (~60 deg latitude): the data must reach the tree draw distance.
const MIN_DETAIL_TILE_M = 150;
const FOREST_RADIUS = Math.max(HIGH_DETAIL_RADIUS, Math.ceil(TREE_DRAW_DISTANCE_M / MIN_DETAIL_TILE_M) - UNLOAD_MARGIN);

function classifyForest(props) {
  return FOREST_LANDCOVER_CLASSES.has(props?.class) ? { key: 'forest', color: FOREST_COLOR } : null;
}

/** Streams forest polygons (see header). */
export const ForestAreasManager = createVectorPolygonLayer({
  tileZoom: FOREST_LANDCOVER_ZOOM,
  layerName: 'landcover',
  classify: classifyForest,
  lift: FOREST_LIFT,
  opacity: FOREST_OPACITY,
  radius: FOREST_RADIUS,
});
