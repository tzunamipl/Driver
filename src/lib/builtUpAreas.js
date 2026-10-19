// Built-up area ("teren zabudowany") from OSM landuse polygons - gameplay
// queries (speed limits, prop placement) via isBuiltUpAt(); the fill is a
// debug overlay. Plumbing is in vectorPolygonLayer.js.

import { createVectorPolygonLayer } from './vectorPolygonLayer.js';

// The landuse layer's maxzoom.
const LANDUSE_TILE_ZOOM = 14;

// Below water, so water still reads on top.
const BUILT_UP_LIFT = 0.1;
const BUILT_UP_OPACITY = 0.3;

// Landuse `class` -> debug colour; other classes aren't built-up.
const BUILT_UP_COLORS = {
  residential: 0xff9800,
  commercial: 0xe040fb,
  retail: 0xe040fb,
  industrial: 0x9575cd,
};

// Roads often run in gaps between adjacent landuse polygons; probing a ring
// this far around bridges them (and extends the zone by as much past its edge).
const GAP_TOLERANCE_M = 30;
const GAP_PROBES = 8;
const PROBE_OFFSETS = Array.from({ length: GAP_PROBES }, (_, i) => {
  const a = (i / GAP_PROBES) * Math.PI * 2;
  return { dx: Math.cos(a) * GAP_TOLERANCE_M, dz: Math.sin(a) * GAP_TOLERANCE_M };
});

function classifyLanduse(props) {
  const color = BUILT_UP_COLORS[props?.class];
  return color == null ? null : { key: props.class, color };
}

const LanduseLayer = createVectorPolygonLayer({
  tileZoom: LANDUSE_TILE_ZOOM,
  layerName: 'landuse',
  classify: classifyLanduse,
  lift: BUILT_UP_LIFT,
  opacity: BUILT_UP_OPACITY,
});

/** Streams built-up landuse polygons (see header). classifyAt() gives the landuse class. */
export class BuiltUpAreasManager extends LanduseLayer {
  /** True if world (x, z) is in (or within GAP_TOLERANCE_M of) a built-up area. */
  isBuiltUpAt(x, z) {
    if (this.classifyAt(x, z)) return true;
    return PROBE_OFFSETS.some(({ dx, dz }) => this.classifyAt(x + dx, z + dz) !== null);
  }
}
