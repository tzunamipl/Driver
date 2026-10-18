// OSM roads as flat stripes coloured/sized by class (roadClasses.js),
// debug overlay on the M key. Always streams: containsPoint() drives the
// road tyre-grip surface (terrainSurface.js). Plumbing: vectorLineLayer.js.

import { createVectorLineLayer } from './vectorLineLayer.js';
import { classifyRoad } from './roadClasses.js';
import { DETAIL_BOX } from './terrain.js';

// The transportation layer's maxzoom.
const STREET_TILE_ZOOM = 14;

// Lift above ground, against z-fighting.
const STREET_LIFT = 0.2;

/** roadClasses {key, color, width} -> vectorLineLayer {key, color, linewidth}, plus brunnel for roadPosts.js. */
function classify(props) {
  const style = classifyRoad(props);
  if (!style) return null;
  return { key: style.key, color: style.color, linewidth: style.width, brunnel: props.brunnel };
}

/** Streams road centerlines (see header). */
export const StreetsManager = createVectorLineLayer({
  tileZoom: STREET_TILE_ZOOM,
  layerName: 'transportation',
  classify,
  lift: STREET_LIFT,
  flat: true,
  alwaysStream: true,
  radius: DETAIL_BOX, // every DETAIL_ZOOM tile terrain streams (HIGH, MEDIUM and LOW)
});
