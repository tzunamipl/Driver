// Street lamps along OSM roads in built-up areas, alternating sides, where they
// replace the posts: a roadside.js kind. The arm reaches over the road (local
// +z); streetLights.js lights them at night.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { localToLatLon } from './geo.js';
import { edgeSpots, builtUpReady } from './roadPosts.js';
import { STREET_LAMP_SPACING_M } from '../config.js';

const EDGE_OFFSET_M = 0.5; // outside the stripe edge
const POLE_HEIGHT_M = 7;
const POLE_WIDTH_M = 0.14;
const POLE_SINK_M = 0.1;
const ARM_LENGTH_M = 1.8;
const ARM_WIDTH_M = 0.08;
const HEAD_WIDTH_M = 0.35;
const HEAD_HEIGHT_M = 0.12;
const HEAD_LENGTH_M = 0.6;
const DEBRIS_MASS = 4;
const DEBRIS_SPHERE_RADIUS = 0.07;

/** Lamp head (light source) relative to the lamp's ground origin, before yaw. */
export const LAMP_HEAD = new THREE.Vector3(0, POLE_HEIGHT_M - HEAD_HEIGHT_M - 0.01, ARM_LENGTH_M);

/** Group 0 = metal, group 1 = the downward-facing bulb. */
function createLampGeometry() {
  const poleHeight = POLE_HEIGHT_M + POLE_SINK_M;
  const metal = mergeGeometries([
    new THREE.BoxGeometry(POLE_WIDTH_M, poleHeight, POLE_WIDTH_M).translate(0, poleHeight / 2 - POLE_SINK_M, 0),
    new THREE.BoxGeometry(ARM_WIDTH_M, ARM_WIDTH_M, ARM_LENGTH_M).translate(0, POLE_HEIGHT_M - ARM_WIDTH_M / 2, ARM_LENGTH_M / 2),
    new THREE.BoxGeometry(HEAD_WIDTH_M, HEAD_HEIGHT_M, HEAD_LENGTH_M).translate(0, POLE_HEIGHT_M - HEAD_HEIGHT_M / 2, ARM_LENGTH_M),
  ]);
  const bulb = new THREE.PlaneGeometry(HEAD_WIDTH_M * 0.8, HEAD_LENGTH_M * 0.8)
    .rotateX(Math.PI / 2) // facing down
    .translate(0, LAMP_HEAD.y, ARM_LENGTH_M);
  return mergeGeometries([metal, bulb], true);
}

/**
 * @param {import('./streets.js').StreetsManager} streets
 * @param {import('./builtUpAreas.js').BuiltUpAreasManager} builtUpAreas
 */
export function createStreetLampKind(streets, builtUpAreas, spacing = STREET_LAMP_SPACING_M) {
  /** Lamp positions for one segment, sides taking turns, built-up stretches only; null until that data is in. */
  function place(seg) {
    if (!builtUpReady(builtUpAreas, seg)) return null;
    const keep = (s, x, z) => builtUpAreas.isBuiltUpAt(x, z);
    const { originLat, originLon, scaleLat } = streets;
    return edgeSpots(streets, seg, { step: spacing, edgeOffset: EDGE_OFFSET_M, keep, alternate: true }).map((p) => ({
      ...localToLatLon(p.x, p.z, originLat, originLon, scaleLat),
      yaw: p.yaw,
    }));
  }

  const cy = POLE_HEIGHT_M / 2;
  const bulbMaterial = new THREE.MeshStandardMaterial({ color: 0x404040, emissive: 0xffd9a0, emissiveIntensity: 0 });
  return {
    group: 'streetLamps',
    hitSound: 'metal',
    geometry: createLampGeometry(),
    material: [new THREE.MeshStandardMaterial({ color: 0x6e7378, roughness: 0.5, metalness: 0.4 }), bulbMaterial],
    bulbMaterial, // streetLights.js drives its glow
    halfExtents: { x: POLE_WIDTH_M / 2, y: cy, z: POLE_WIDTH_M / 2 },
    debrisSpheres: [
      ...[-0.85, -0.3, 0.3, 0.85].map((f) => [0, f * cy, 0]),
      [0, POLE_HEIGHT_M - cy, ARM_LENGTH_M], // arm end
    ],
    debrisRadius: DEBRIS_SPHERE_RADIUS,
    mass: DEBRIS_MASS,
    place,
  };
}
