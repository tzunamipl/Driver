// Debug-only visualization of OSM river/waterway centerlines, drawn as
// wide, ground-hugging blue stripes (sized per waterway class, in
// real-world meters, same as streets.js's road stripes) hovering just
// above the terrain. Purely a debug aid for checking where OSM thinks
// waterways run relative to the loaded terrain/buildings - toggled off
// the same M key as the rest of debugVisuals.js, never shown during
// normal driving.
//
// Data/rendering plumbing (tile fetch/decode, per-segment DETAIL_ZOOM
// bucketing, flat ground-quad meshes, streaming) all lives in
// vectorLineLayer.js, shared with streets.js - this module only supplies
// the `waterway` layer name/zoom, the class->style mapping below, and
// requests flat, ground-hugging stripes (real meters, not screen-space
// fat lines that billboard toward the camera) via the `flat` option.

import { createVectorLineLayer } from './vectorLineLayer.js';

// Same vector tiles buildings.js reads its `building` layer from, at the
// zoom OpenMapTiles' waterway layer tops out at (same zoom as
// buildings.js's BUILDING_TILE_ZOOM).
const RIVER_TILE_ZOOM = 14;

// How far above the sampled ground each line is lifted, so it doesn't
// z-fight with the terrain mesh it's tracing over - slightly more than
// streets.js's lift so a river crossing a road at grade still renders on
// top of it rather than flickering/z-fighting against it.
const RIVER_LIFT = 0.25;

// All blue, as asked - just scaled by OpenMapTiles' waterway `class`
// field (https://openmaptiles.org/schema/#waterway: stream/river/canal/
// drain/ditch) so a major river still reads as "bigger" than a drainage
// ditch while staying unambiguously blue/water-colored. Widths are real-
// world meters (same `flat`/worldUnits ground-stripe approach streets.js
// uses via roadClasses.js's widthMeters), loosely modeled on typical
// channel widths for that class; a debug-visualization aid, not a
// survey-accurate figure.
const WATER_COLOR = 0x1e90ff;
const WATERWAY_STYLES = {
  river: { widthMeters: 12 },
  canal: { widthMeters: 8 },
  stream: { widthMeters: 3 },
  drain: { widthMeters: 1.5 },
  ditch: { widthMeters: 1 },
};

function classifyWaterway(props) {
  const cls = props?.class;
  const style = WATERWAY_STYLES[cls];
  if (!style) return null; // unrecognized class - skip rather than guess a width
  return { key: cls, color: WATER_COLOR, linewidth: style.widthMeters };
}

/** Streams OSM river/waterway centerlines as wide, ground-hugging blue debug stripes (see module doc comment above). */
export const RiversManager = createVectorLineLayer({
  tileZoom: RIVER_TILE_ZOOM,
  layerName: 'waterway',
  classify: classifyWaterway,
  lift: RIVER_LIFT,
  flat: true,
});
