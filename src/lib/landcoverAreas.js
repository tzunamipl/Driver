// OSM landcover polygons (forest, rock, ice, scrub, sand) - classifyAt() gives
// the tyre-grip surface key (terrainSurface.js) and drives trees.js (forest
// trees, scrub bushes); the fill is a debug overlay. The terrain worker reads
// the same layer for the forest floor (terrain/forestFloor.js).
// Plumbing is in vectorPolygonLayer.js.

import { createVectorPolygonLayer } from './vectorPolygonLayer.js';
import { FOREST_LANDCOVER_ZOOM, FOREST_LANDCOVER_CLASSES } from './terrain/forestFloor.js';
import { HIGH_DETAIL_RADIUS, UNLOAD_MARGIN } from './terrain.js';
import { TREE_DRAW_DISTANCE_M } from '../config.js';

// Below built-up and water, so both still read on top.
const LANDCOVER_LIFT = 0.05;
const LANDCOVER_OPACITY = 0.3;

// Surface key -> debug colour.
const LANDCOVER_COLORS = {
  forest: 0x2e7d32,
  scrub: 0x827717,
  rock: 0x78909c,
  ice: 0xe1f5fe,
  sand: 0xffe082,
};

// Landcover `class` -> surface key; scrub is a `grass` subclass, so it's matched on subclass.
const CLASS_KEYS = { rock: 'rock', ice: 'ice', sand: 'sand' };
const SUBCLASS_KEYS = { scrub: 'scrub' };

// Narrowest DETAIL_ZOOM tile the game meets (~60 deg latitude): the data must reach the tree draw distance.
const MIN_DETAIL_TILE_M = 150;
const LANDCOVER_RADIUS = Math.max(HIGH_DETAIL_RADIUS, Math.ceil(TREE_DRAW_DISTANCE_M / MIN_DETAIL_TILE_M) - UNLOAD_MARGIN);

function classifyLandcover(props) {
  const key = FOREST_LANDCOVER_CLASSES.has(props?.class) ? 'forest' : SUBCLASS_KEYS[props?.subclass] ?? CLASS_KEYS[props?.class];
  return key ? { key, color: LANDCOVER_COLORS[key] } : null;
}

/** Streams landcover polygons (see header). classifyAt() gives the surface key. */
export const LandcoverAreasManager = createVectorPolygonLayer({
  tileZoom: FOREST_LANDCOVER_ZOOM,
  layerName: 'landcover',
  classify: classifyLandcover,
  lift: LANDCOVER_LIFT,
  opacity: LANDCOVER_OPACITY,
  radius: LANDCOVER_RADIUS,
});
