// Steel guard rails along road edges where the ground drops away steeply, in
// place of the posts there (roadPosts.js): a roadside.js kind of straight
// sections with gaps between them, each knocked off on its own with a metal clang.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { localToLatLon } from './geo.js';
import { edgeSpots, builtUpReady, EDGE_OFFSET_M } from './roadPosts.js';
import { GUARD_RAIL_DROP_M, GUARD_RAIL_DROP_DISTANCE_M } from '../config.js';

const SECTION_LENGTH_M = 4;
const SECTION_SPACING_M = 16; // centre to centre, so a gap of spacing - length between sections
const POST_XS = [-1, 1]; // posts every 2 m along the rail
const POST_WIDTH_M = 0.1;
const POST_HEIGHT_M = 0.8;
const POST_SINK_M = 0.3; // below the surface, so the slope side doesn't show a gap
const RAIL_BOTTOM_M = 0.5;
const RAIL_HEIGHT_M = 0.32;
const RAIL_DEPTH_M = 0.08; // the W-beam's two ridges, towards the road
const RAIL_PROFILE = [[0, 0], [0.25, 1], [0.5, 0], [0.75, 1], [1, 0]]; // (height, depth) fractions
const DEBRIS_MASS = 40;
const DEBRIS_SPHERE_RADIUS = 0.1;

/**
 * Edge test shared with the posts: (x, z, ox, oz, halfWidth) of a centreline point and outward
 * unit normal -> true if the ground GUARD_RAIL_DROP_DISTANCE_M past the road bed's flat top
 * (stripe edge plus a grid cell, see terrain/roadBed.js) is GUARD_RAIL_DROP_M or more below
 * the stripe edge, null while that detail terrain isn't loaded.
 * @param {import('./terrain.js').TerrainManager} terrain
 */
export function createDropOffCheck(terrain) {
  return (x, z, ox, oz, halfWidth) => {
    const ex = x + ox * halfWidth;
    const ez = z + oz * halfWidth;
    const road = terrain.detailHeightAt(ex, ez);
    const cell = terrain.detailCellAt(ex, ez);
    if (road == null || cell == null) return null;
    const out = halfWidth + cell + GUARD_RAIL_DROP_DISTANCE_M;
    const ground = terrain.detailHeightAt(x + ox * out, z + oz * out);
    if (ground == null) return null;
    return road - ground >= GUARD_RAIL_DROP_M;
  };
}

/** The W-beam as one bent zero-thickness sheet (drawn double-sided) along local x, ridges towards +z. */
function createRailGeometry() {
  const half = SECTION_LENGTH_M / 2;
  const position = [];
  const uv = [];
  const index = [];
  RAIL_PROFILE.forEach(([h, d], i) => {
    const y = RAIL_BOTTOM_M + h * RAIL_HEIGHT_M;
    position.push(-half, y, d * RAIL_DEPTH_M, half, y, d * RAIL_DEPTH_M);
    uv.push(0, h, 1, h);
    if (i > 0) {
      const a = 2 * (i - 1);
      index.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/** One section along local x; the rail faces the road (local +z), posts behind it. */
function createSectionGeometry() {
  const postHeight = POST_HEIGHT_M + POST_SINK_M;
  return mergeGeometries([
    ...POST_XS.map((x) =>
      new THREE.BoxGeometry(POST_WIDTH_M, postHeight, POST_WIDTH_M).translate(x, postHeight / 2 - POST_SINK_M, -POST_WIDTH_M / 2)
    ),
    createRailGeometry(),
  ]);
}

/**
 * @param {import('./streets.js').StreetsManager} streets
 * @param {import('./builtUpAreas.js').BuiltUpAreasManager} builtUpAreas - only outside, like the posts
 * @param {import('./terrain.js').TerrainManager} terrain
 */
export function createGuardRailKind(streets, builtUpAreas, terrain) {
  const isDropOff = createDropOffCheck(terrain);

  /** Section centres on drop-off edges; null until built-up and terrain data are in. */
  function place(seg) {
    if (!builtUpReady(builtUpAreas, seg)) return null;
    let ready = true;
    const keepEdge = (...edge) => {
      const drop = isDropOff(...edge);
      if (drop == null) ready = false;
      return drop === true;
    };
    const keep = (s, x, z) => !builtUpAreas.isBuiltUpAt(x, z);
    const spots = edgeSpots(streets, seg, { step: SECTION_SPACING_M, edgeOffset: EDGE_OFFSET_M, keep, keepEdge });
    if (!ready) return null;
    const { originLat, originLon, scaleLat } = streets;
    return spots.map((p) => ({ ...localToLatLon(p.x, p.z, originLat, originLon, scaleLat), yaw: p.yaw }));
  }

  const top = RAIL_BOTTOM_M + RAIL_HEIGHT_M;
  const cy = top / 2;
  const railY = RAIL_BOTTOM_M + RAIL_HEIGHT_M / 2 - cy;
  const half = SECTION_LENGTH_M / 2;
  return {
    group: 'guardRails',
    hitSound: 'metal',
    followSlope: true,
    geometry: createSectionGeometry(),
    material: new THREE.MeshStandardMaterial({ color: 0xa9adb1, roughness: 0.45, metalness: 0.6, side: THREE.DoubleSide }),
    halfExtents: { x: half, y: cy, z: 0.1 },
    debrisSpheres: [
      ...[-0.9, -0.3, 0.3, 0.9].map((f) => [f * half, railY, 0]),
      ...POST_XS.map((x) => [x, -cy + DEBRIS_SPHERE_RADIUS, -POST_WIDTH_M / 2]),
    ],
    debrisRadius: DEBRIS_SPHERE_RADIUS,
    mass: DEBRIS_MASS,
    place,
  };
}
