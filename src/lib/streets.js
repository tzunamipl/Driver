// Debug-only visualization of OSM street/road centerlines, drawn as wide
// stripes (sized per road class, in real-world meters - see
// roadClasses.js) hovering just above the terrain, colored by the OSM
// road hierarchy (motorway down to footpath) so it reads like a
// simplified road-atlas overlay. Purely a debug aid for checking where
// OSM thinks the roads run relative to the loaded terrain/buildings -
// toggled off the same M key as the rest of debugVisuals.js, never shown
// during normal driving.
//
// Data/rendering plumbing (tile fetch/decode, per-segment DETAIL_ZOOM
// bucketing, flat ground-quad meshes, streaming) all lives in
// vectorLineLayer.js, shared with rivers.js - this module only supplies
// the `transportation` layer name/zoom, plumbs classifyRoad's {key,
// color, width} style into vectorLineLayer's {key, color, linewidth}
// shape, and requests flat, ground-hugging stripes (real meters, not
// screen-space fat lines that billboard toward the camera) via the
// `flat` option. All the actual per-class color/width parameters live in
// roadClasses.js.

import { createVectorLineLayer } from './vectorLineLayer.js';
import { classifyRoad } from './roadClasses.js';

// Same vector tiles buildings.js reads its `building` layer from, at the
// zoom OpenMapTiles' transportation layer tops out at (same zoom as
// buildings.js's BUILDING_TILE_ZOOM).
const STREET_TILE_ZOOM = 14;

// How far above the sampled ground each stripe is lifted, so it doesn't
// z-fight with the terrain mesh it's tracing over.
const STREET_LIFT = 0.2;

/** Adapts roadClasses.js's {key, color, width} style to vectorLineLayer's generic {key, color, linewidth} shape. */
function classify(props) {
  const style = classifyRoad(props);
  if (!style) return null;
  return { key: style.key, color: style.color, linewidth: style.width };
}

/** Streams OSM street centerlines as wide, hierarchy-colored debug stripes (see module doc comment above). */
export const StreetsManager = createVectorLineLayer({
  tileZoom: STREET_TILE_ZOOM,
  layerName: 'transportation',
  classify,
  lift: STREET_LIFT,
  flat: true,
});
