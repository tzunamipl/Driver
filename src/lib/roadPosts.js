// Simple white posts along both edges of OSM roads, as 3D cues for where the
// road runs: a roadside.js kind, placed at a fixed spacing along each line.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { latLonToLocal, localToLatLon } from './geo.js';
import { isRoadsideRoad } from './roadside.js';
import { ROAD_POST_SPACING_M } from '../config.js';

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

/** @param {import('./streets.js').StreetsManager} streets */
export function createRoadPostKind(streets, spacing = ROAD_POST_SPACING_M) {
  /** Post positions for one segment, both sides, minus any landing on another road. */
  function place(seg) {
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
    const offset = halfWidth + EDGE_OFFSET_M;
    const checkOffset = halfWidth + Math.max(EDGE_OFFSET_M, JUNCTION_CHECK_M); // never inside its own stripe
    // Half-open [dist, dist + len), so a post on a piece boundary isn't placed twice.
    for (let k = Math.ceil(seg.dist / spacing); k * spacing < seg.dist + seg.len; k++) {
      const t = (k * spacing - seg.dist) / seg.len;
      const cx = a.x + dx * t;
      const cz = a.z + dz * t;
      for (const side of [-1, 1]) {
        if (streets.containsPoint(cx + nx * checkOffset * side, cz + nz * checkOffset * side)) continue;
        const px = cx + nx * offset * side;
        const pz = cz + nz * offset * side;
        out.push(localToLatLon(px, pz, originLat, originLon, scaleLat));
      }
    }
    return out;
  }

  return {
    group: 'roadPosts',
    geometry: createPostGeometry(),
    material: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }),
    halfExtents: { x: POST_WIDTH_M / 2, y: POST_HEIGHT_M / 2, z: POST_WIDTH_M / 2 },
    debrisSpheres: DEBRIS_SPHERE_YS.map((y) => [0, y, 0]),
    debrisRadius: DEBRIS_SPHERE_RADIUS,
    mass: DEBRIS_MASS,
    place,
  };
}
