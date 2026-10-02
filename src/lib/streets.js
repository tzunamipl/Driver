// Debug-only visualization of OSM street/road centerlines, drawn as broad
// (fat) lines hovering just above the terrain, colored by the OSM road
// hierarchy (motorway down to footpath) so it reads like a simplified
// road-atlas overlay. Purely a debug aid for checking where OSM thinks the
// roads run relative to the loaded terrain/buildings - toggled off the
// same M key as the rest of debugVisuals.js, never shown during normal
// driving.
//
// Data/rendering plumbing (tile fetch/decode, per-segment DETAIL_ZOOM
// bucketing, fat-line meshes, streaming) all lives in vectorLineLayer.js,
// shared with rivers.js - this module only supplies the `transportation`
// layer name/zoom and the class->style mapping below.

import { createVectorLineLayer } from './vectorLineLayer.js';

// Same vector tiles buildings.js reads its `building` layer from, at the
// zoom OpenMapTiles' transportation layer tops out at (same zoom as
// buildings.js's BUILDING_TILE_ZOOM).
const STREET_TILE_ZOOM = 14;

// How far above the sampled ground each line is lifted, so it doesn't
// z-fight with the terrain mesh it's tracing over.
const STREET_LIFT = 0.2;

// OpenMapTiles' transportation layer `class` field is literally "the OSM
// road hierarchy" (see https://openmaptiles.org/schema/#transportation) -
// color progresses from red (motorway, the most important) to grey
// (footpaths/service roads, the least important), with line width scaling
// the same direction so importance reads via both color and thickness.
// `*_construction` variants (roads mid-build) reuse their finished
// class's style, just thinner, so they're still visually distinguishable.
const RED = [0xff, 0x1a, 0x1a];
const GREY = [0x8a, 0x8a, 0x8a];

/** Linear-interpolates two [r, g, b] (0-255) triples at `t` (0..1) into a single 0xRRGGBB int. */
function lerpColor(a, b, t) {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return (r << 16) | (g << 8) | bl;
}

// Main hierarchy, ordered most -> least important; each step's color is
// linearly interpolated between RED (first) and GREY (last).
const ROAD_HIERARCHY = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'track', 'path'];
const MAX_LINEWIDTH = 7;
const MIN_LINEWIDTH = 1.5;

const ROAD_STYLES = {};
ROAD_HIERARCHY.forEach((cls, i) => {
  const t = i / (ROAD_HIERARCHY.length - 1);
  ROAD_STYLES[cls] = {
    color: lerpColor(RED, GREY, t),
    linewidth: MAX_LINEWIDTH + (MIN_LINEWIDTH - MAX_LINEWIDTH) * t,
  };
});
// Special-purpose road classes that don't fit the main importance
// hierarchy - styled the same as the nearest-equivalent tier above
// (grey/thin "minor infrastructure" look) rather than getting their own
// slot in the red->grey gradient.
ROAD_STYLES.busway = ROAD_STYLES.bus_guideway = ROAD_STYLES.service;
ROAD_STYLES.raceway = ROAD_STYLES.tertiary;

// Not a road at all (a shipping line) - not meaningful for a "streets" debug view.
const SKIP_CLASSES = new Set(['ferry']);

function classifyRoad(props) {
  let cls = props?.class;
  if (!cls || SKIP_CLASSES.has(cls)) return null;

  let underConstruction = false;
  if (cls.endsWith('_construction')) {
    underConstruction = true;
    cls = cls.slice(0, -'_construction'.length);
  }

  const base = ROAD_STYLES[cls];
  if (!base) return null; // unrecognized/rail-ish class - not a street

  return {
    key: underConstruction ? `${cls}_construction` : cls,
    color: base.color,
    linewidth: underConstruction ? Math.max(MIN_LINEWIDTH, base.linewidth - 1.5) : base.linewidth,
  };
}

/** Streams OSM street centerlines as broad, hierarchy-colored debug lines (see module doc comment above). */
export const StreetsManager = createVectorLineLayer({
  tileZoom: STREET_TILE_ZOOM,
  layerName: 'transportation',
  classify: classifyRoad,
  lift: STREET_LIFT,
});
