// Streams OSM water body polygons (oceans, lakes, ponds, and wide rivers
// rendered as filled areas rather than centerlines) the same way
// buildings.js/streets.js/rivers.js are. Complements rivers.js (which
// only draws the OSM `waterway` *line* layer - narrow streams/canals/
// ditches that are mapped as centerlines, not polygons) - together they
// cover both ways OSM represents water.
//
// Two independent consumers: the flat, ground-hugging blue fill *mesh* is
// a debug aid only, toggled with the M key (debugVisuals.js) and never
// shown during normal driving; but the underlying polygon *data*
// (classifyAt) streams unconditionally (see vectorPolygonLayer.js's
// doc comment) and drives lib/splash.js's "is this wheel over water"
// check for the wheel-splash particle effect, which runs regardless of
// whether the debug overlay is visible.
//
// Data/rendering plumbing (tile fetch/decode, polygon-centroid bucketing,
// flat merged-mesh fills, streaming) all lives in vectorPolygonLayer.js -
// this module only supplies the `water` layer name/zoom and the
// class->style mapping below.

import { createVectorPolygonLayer } from './vectorPolygonLayer.js';

// Same vector tiles buildings.js/streets.js/rivers.js read their layers
// from, at the same zoom (OpenMapTiles' water layer tops out here too).
const WATER_TILE_ZOOM = 14;

// How far above the sampled ground each fill is lifted - less than
// streets.js's (0.2) or rivers.js's (0.25) lift, so a road/river
// centerline crossing a water body's fill still renders on top of it
// rather than z-fighting/flickering against it.
const WATER_LIFT = 0.15;

// Single flat blue fill for every water class - oceans/lakes/ponds/wide
// rivers all read as "water" at a glance; not worth a color gradient the
// way roadClasses.js's hierarchy is, since there's no equivalent
// importance ordering here.
const WATER_COLOR = 0x1e6fae;

// OpenMapTiles' `water` layer `class` field (verified against live
// OpenFreeMap tiles - the schema docs site doesn't expose this cleanly):
// everything else is skipped rather than guessed at.
const WATER_CLASSES = new Set(['ocean', 'lake', 'river', 'pond']);

function classifyWater(props) {
  const cls = props?.class;
  if (!WATER_CLASSES.has(cls)) return null;
  return { key: 'water', color: WATER_COLOR };
}

/** Streams OSM water body polygons as flat blue debug fills (see module doc comment above). */
export const WaterAreasManager = createVectorPolygonLayer({
  tileZoom: WATER_TILE_ZOOM,
  layerName: 'water',
  classify: classifyWater,
  lift: WATER_LIFT,
});
