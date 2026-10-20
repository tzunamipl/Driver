// OSM landcover polygons (forest, rock, ice, scrub, sand) - classifyAt() gives
// the tyre-grip surface key (terrainSurface.js) and drives trees.js (forest
// trees, scrub bushes); the fill is a debug overlay showing every landcover class
// (grass, farmland, wetland, ... are overlay-only). The terrain worker reads
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
// Debug-only keys: drawn, but invisible to classifyAt()/isNear() so gameplay is unchanged.
const DEBUG_ONLY_COLORS = {
  grass: 0x9ccc65,
  farmland: 0x8d6e63,
  wetland: 0x26a69a,
  other: 0xf06292, // any class not listed here
};

// Landcover `class` -> surface key; scrub is a `grass` subclass, so it's matched on subclass.
const CLASS_KEYS = { rock: 'rock', ice: 'ice', sand: 'sand' };
const SUBCLASS_KEYS = { scrub: 'scrub' };

// Narrowest DETAIL_ZOOM tile the game meets (~60 deg latitude): the data must reach the tree draw distance.
const MIN_DETAIL_TILE_M = 150;
const LANDCOVER_RADIUS = Math.max(HIGH_DETAIL_RADIUS, Math.ceil(TREE_DRAW_DISTANCE_M / MIN_DETAIL_TILE_M) - UNLOAD_MARGIN);

/** Debug label: the OSM class, plus the subclass when it adds something (e.g. "grass · meadow"). */
function landcoverLabel({ class: cls, subclass }) {
  return subclass && subclass !== cls ? `${cls} · ${subclass}` : cls;
}

function classifyLandcover(props) {
  const key = FOREST_LANDCOVER_CLASSES.has(props?.class) ? 'forest' : SUBCLASS_KEYS[props?.subclass] ?? CLASS_KEYS[props?.class];
  if (key) return { key, color: LANDCOVER_COLORS[key], label: landcoverLabel(props) };
  if (props?.class == null) return null;
  const debugKey = props.class in DEBUG_ONLY_COLORS ? props.class : 'other';
  return { key: debugKey, color: DEBUG_ONLY_COLORS[debugKey], debugOnly: true, label: landcoverLabel(props) };
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
