// Simple white posts along both edges of OSM roads, as 3D cues for where the
// road runs: a roadside.js kind, placed at a fixed spacing along each line
// (denser through hairpins). Built-up areas get street lamps instead (streetLamps.js),
// steep drop-offs guard rails (guardRails.js).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { latLonToLocal, localToLatLon } from './geo.js';
import { isRoadsideRoad } from './roadside.js';
import { hairpinSpans } from './roadSigns.js';
import { createDropOffCheck } from './guardRails.js';
import { ROAD_POST_SPACING_M, ROAD_POST_HAIRPIN_DENSITY } from '../config.js';

const EDGE_OFFSET_M = -1.0; // outside the stripe edge; negative = inside the road
const JUNCTION_CHECK_M = 0.1; // just past the edge: another road there drops the post, wherever it stands
const POST_HEIGHT_M = 1;
const POST_WIDTH_M = 0.12;
const POST_SINK_M = 0.1; // below the surface, so slopes don't show a gap
const BAND_HEIGHT_M = 0.2; // dark band at the top
const DEBRIS_MASS = 4;
const DEBRIS_SPHERE_RADIUS = 0.07;
const DEBRIS_SPHERE_YS = [-0.4, 0, 0.4]; // from the post's middle

/** Fills a geometry's vertex colours with one colour. */
function paintGeometry(geometry, hex) {
  const c = new THREE.Color(hex);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function createPostGeometry() {
  const bodyHeight = POST_HEIGHT_M + POST_SINK_M - BAND_HEIGHT_M;
  const body = new THREE.BoxGeometry(POST_WIDTH_M, bodyHeight, POST_WIDTH_M).translate(0, bodyHeight / 2 - POST_SINK_M, 0);
  const band = new THREE.BoxGeometry(POST_WIDTH_M, BAND_HEIGHT_M, POST_WIDTH_M).translate(
    0,
    POST_HEIGHT_M - BAND_HEIGHT_M / 2,
    0
  );
  return mergeGeometries([paintGeometry(body, 0xf2f2f2), paintGeometry(band, 0x1a1a1a)]);
}

/**
 * Spots along the edges of one segment, `edgeOffset` out from the stripe edge, at multiples
 * of `step` metres along its line where `keep(s, x, z)` (centreline point) says so, on both
 * sides or, if `alternate`, one side per step taking turns, where `keepEdge(x, z, ox, oz, halfWidth)`
 * (centreline point, outward unit normal) says so, minus any
 * landing on another road: [{ x, z, yaw }] in local metres, yaw turning local +z towards the road.
 * @param {import('./streets.js').StreetsManager} streets
 */
export function edgeSpots(streets, seg, { step, edgeOffset, keep = () => true, keepEdge = () => true, alternate = false }) {
  const out = [];
  const { style } = seg;
  if (seg.buffer || !isRoadsideRoad(style)) return out;
  const { originLat, originLon, scaleLat } = streets;
  const a = latLonToLocal(seg.a.lat, seg.a.lon, originLat, originLon, scaleLat);
  const b = latLonToLocal(seg.b.lat, seg.b.lon, originLat, originLon, scaleLat);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-6 || seg.len < 1e-6) return out;
  const nx = -dz / length;
  const nz = dx / length;
  const halfWidth = style.linewidth / 2;
  const offset = halfWidth + edgeOffset;
  const checkOffset = halfWidth + Math.max(edgeOffset, JUNCTION_CHECK_M); // never inside its own stripe
  // Half-open [dist, dist + len), so a spot on a piece boundary isn't placed twice.
  for (let k = Math.ceil(seg.dist / step); k * step < seg.dist + seg.len; k++) {
    const t = (k * step - seg.dist) / seg.len;
    const cx = a.x + dx * t;
    const cz = a.z + dz * t;
    if (!keep(k * step, cx, cz)) continue;
    for (const side of alternate ? [k % 2 ? 1 : -1] : [-1, 1]) {
      if (streets.containsPoint(cx + nx * checkOffset * side, cz + nz * checkOffset * side)) continue;
      if (!keepEdge(cx, cz, nx * side, nz * side, halfWidth)) continue;
      out.push({ x: cx + nx * offset * side, z: cz + nz * offset * side, yaw: Math.atan2(-nx * side, -nz * side) });
    }
  }
  return out;
}

/** True once built-up data covers the segment, so edgeSpots' built-up checks are final. */
export function builtUpReady(builtUpAreas, seg) {
  return builtUpAreas.hasDataAt((seg.a.lat + seg.b.lat) / 2, (seg.a.lon + seg.b.lon) / 2);
}

/**
 * @param {import('./streets.js').StreetsManager} streets
 * @param {import('./builtUpAreas.js').BuiltUpAreasManager} builtUpAreas - street lamps stand there instead
 * @param {import('./terrain.js').TerrainManager} terrain - guard rails replace them on drop-offs
 */
export function createRoadPostKind(streets, builtUpAreas, terrain, spacing = ROAD_POST_SPACING_M) {
  // Fine grid; the regular one is every DENSITY-th step, so the two line up.
  const step = spacing / ROAD_POST_HAIRPIN_DENSITY;
  const isDropOff = createDropOffCheck(terrain);

  /** Post positions for one segment, both sides; null until built-up and terrain data are in. */
  function place(seg) {
    if (!builtUpReady(builtUpAreas, seg)) return null;
    let ready = true;
    const keepEdge = (...edge) => {
      const drop = isDropOff(...edge);
      if (drop == null) ready = false;
      return drop === false;
    };
    const spans = hairpinSpans(seg.line, streets);
    const keep = (s, x, z) =>
      (Math.round(s / step) % ROAD_POST_HAIRPIN_DENSITY === 0 || spans.some(([from, to]) => s >= from && s <= to)) &&
      !builtUpAreas.isBuiltUpAt(x, z);
    const { originLat, originLon, scaleLat } = streets;
    const spots = edgeSpots(streets, seg, { step, edgeOffset: EDGE_OFFSET_M, keep, keepEdge });
    if (!ready) return null;
    return spots.map((p) => localToLatLon(p.x, p.z, originLat, originLon, scaleLat));
  }

  return {
    group: 'roadPosts',
    geometry: createPostGeometry(),
    material: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, flatShading: true }),
    halfExtents: { x: POST_WIDTH_M / 2, y: POST_HEIGHT_M / 2, z: POST_WIDTH_M / 2 },
    debrisSpheres: DEBRIS_SPHERE_YS.map((y) => [0, y, 0]),
    debrisRadius: DEBRIS_SPHERE_RADIUS,
    mass: DEBRIS_MASS,
    place,
  };
}
