// OSM roads as flat stripes coloured/sized by class (roadClasses.js),
// debug overlay on the M key. Always streams: surfaceAt() drives the
// road/unpaved tyre-grip surface (terrainSurface.js). Plumbing: vectorLineLayer.js.

import { createVectorLineLayer } from './vectorLineLayer.js';
import { classifyRoad } from './roadClasses.js';
import { DETAIL_BOX } from './terrain.js';

// The transportation layer's maxzoom.
const STREET_TILE_ZOOM = 14;

// Lift above ground, against z-fighting.
const STREET_LIFT = 0.2;

/** roadClasses {key, color, width, unpaved} -> vectorLineLayer {key, color, linewidth}, plus brunnel for roadside.js. */
function classify(props) {
  const style = classifyRoad(props);
  if (!style) return null;
  return { key: style.key, color: style.color, linewidth: style.width, unpaved: style.unpaved, brunnel: props.brunnel };
}

const StreetLayer = createVectorLineLayer({
  tileZoom: STREET_TILE_ZOOM,
  layerName: 'transportation',
  classify,
  lift: STREET_LIFT,
  flat: true,
  alwaysStream: true,
  radius: DETAIL_BOX, // every DETAIL_ZOOM tile terrain streams (HIGH, MEDIUM and LOW)
});

/** Streams road centerlines (see header). */
export class StreetsManager extends StreetLayer {
  /** 'road' if a paved stripe covers world (x, z), else 'unpaved' if an unpaved one does, else null. */
  surfaceAt(x, z) {
    let hit = null;
    for (const style of this.stylesAt(x, z)) {
      if (!style.unpaved) return 'road'; // paved wins where they overlap (junctions)
      hit = 'unpaved';
    }
    return hit;
  }
}
