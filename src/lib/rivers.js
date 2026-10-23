// River/waterway centerlines as flat blue stripes (debug overlay, K key).
// Data always streams: containsPoint() feeds splash.js for waterways too
// narrow to exist as water polygons. Plumbing is in vectorLineLayer.js.

import { createVectorLineLayer } from './vectorLineLayer.js';

// The waterway layer's maxzoom.
const RIVER_TILE_ZOOM = 14;

// Slightly above streets' lift, so rivers draw over roads at grade.
const RIVER_LIFT = 0.25;

// Blue, width (m) by waterway class (rough real channel widths).
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

/** Streams river/waterway centerlines (see header). */
export const RiversManager = createVectorLineLayer({
  tileZoom: RIVER_TILE_ZOOM,
  layerName: 'waterway',
  classify: classifyWaterway,
  lift: RIVER_LIFT,
  flat: true,
  alwaysStream: true,
});
