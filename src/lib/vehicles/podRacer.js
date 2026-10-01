// Vehicle definition: "Chariot of Fire" pod racer - jet engines up front,
// a driver's pod trailing behind on a tether, loosely modeled on a Star
// Wars-style podracer. Self-contained visuals only (see ../chariot.js for
// the hover/differential-thrust physics rig that actually drives it) so
// this one vehicle kind can be reskinned without touching the shared rig
// or any other vehicle's file - see ./index.js for how descriptors get
// collected into the selectable roster.
//
// `engineCount` is a constructor parameter (not hardcoded) specifically so
// new variants can be added later as thin wrappers around
// createPodRacerVehicle(n) without copy-pasting the mesh/physics code -
// see the bottom of this file for the one registered demo variant (3
// engines).
//
// Two different body builders are exported because the pod isn't rigidly
// attached to the engines (see chariot.js's tether physics - it's pulled
// along, not bolted on):
//  - buildBody(): one rigid group (engines + pod + tether, fixed relative
//    transforms) - used for *remote* players, who only ever get a single
//    interpolated pose over the network, so a fully soft pod isn't
//    reproducible there anyway.
//  - buildLocalRig(): one rigid engine group (engines + power couplings,
//    driven 1:1 by a single physics body - see chariot.js's chassisBody)
//    plus a genuinely separate pod group and live tether meshes - used
//    for the *local* player's chariot (lib/chariot.js), where the pod
//    really is a second physics body tethered to the engine rig, but the
//    engines themselves are one rigid formation (what you see is exactly
//    what the tether is attached to - no separate invisible physics body
//    for the engines to drift out of sync with).

import * as THREE from 'three';
import {
  ENGINE_RADIUS,
  ENGINE_LENGTH,
  POD_RADIUS,
  POD_LENGTH,
  engineLocalOffsets,
  POD_LOCAL_OFFSET,
} from './podRacerLayout.js';

const DEFAULT_BODY_COLOR = 0xff6a1a; // flame orange

const engineBodyMat = new THREE.MeshStandardMaterial({ color: 0x8a8d93, metalness: 0.8, roughness: 0.35 });
const engineGlowMat = new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xff6a00, emissiveIntensity: 1.4, roughness: 0.3 });
const couplingMat = new THREE.MeshStandardMaterial({ color: 0x3fb8ff, emissive: 0x1e6f99, emissiveIntensity: 0.9, roughness: 0.25 });
const tetherMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.3, roughness: 0.7 });
const podGlassMat = new THREE.MeshStandardMaterial({ color: 0x141a20, metalness: 0.6, roughness: 0.15 });

/**
 * One simple-cylinder jet engine: a grey body with a glowing rear nozzle,
 * oriented so its length runs along local Z (nose pointing +Z, matching
 * the chassis' own "front" axis).
 */
function buildEngine() {
  const group = new THREE.Group();
  const bodyGeo = new THREE.CylinderGeometry(ENGINE_RADIUS, ENGINE_RADIUS * 0.85, ENGINE_LENGTH, 12);
  bodyGeo.rotateX(Math.PI / 2);
  const body = new THREE.Mesh(bodyGeo, engineBodyMat);
  body.castShadow = true;
  group.add(body);

  const glowGeo = new THREE.CylinderGeometry(ENGINE_RADIUS * 0.6, ENGINE_RADIUS * 0.6, 0.12, 12);
  glowGeo.rotateX(Math.PI / 2);
  const glow = new THREE.Mesh(glowGeo, engineGlowMat);
  glow.position.z = -ENGINE_LENGTH / 2 - 0.02;
  group.add(glow);

  return group;
}

/** The pod (driver's seat) + a small cockpit glass cap, as a standalone group centered on its own origin. */
function buildPod(color) {
  const group = new THREE.Group();
  const podMat = new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.5 });

  const podGeo = new THREE.CapsuleGeometry(POD_RADIUS, POD_LENGTH, 4, 8);
  podGeo.rotateX(Math.PI / 2);
  const pod = new THREE.Mesh(podGeo, podMat);
  pod.castShadow = true;
  group.add(pod);

  const glassGeo = new THREE.SphereGeometry(POD_RADIUS * 0.55, 10, 8);
  const glass = new THREE.Mesh(glassGeo, podGlassMat);
  glass.position.set(0, POD_RADIUS * 0.4, POD_LENGTH * 0.25);
  group.add(glass);

  return { group, bodyMat: podMat };
}

const STRUT_UP = new THREE.Vector3(0, 1, 0);

/**
 * A unit-length cylinder mesh meant to be re-aimed/re-scaled every call to
 * `orientStrut` (below) rather than rebuilt - used for the live tethers
 * (re-oriented every frame from the engine rig's current transform to the
 * pod's current position).
 */
function buildStrutMesh(radius, material) {
  const geo = new THREE.CylinderGeometry(radius, radius, 1, 6);
  return new THREE.Mesh(geo, material);
}

/** Points and stretches a buildStrutMesh() cylinder to run exactly from `from` to `to` (any two {x,y,z}-like points, same space). */
function orientStrut(mesh, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dy, dz) || 0.0001;
  mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  mesh.scale.set(1, length, 1);
  mesh.quaternion.setFromUnitVectors(STRUT_UP, new THREE.Vector3(dx, dy, dz).normalize());
}

/**
 * Tethers attach at the rear-top of each engine (local -Z/+Y, matching
 * buildEngine()'s nose-points-+Z orientation) rather than its dead
 * centre - reads more like a cable clipped onto the engine housing than
 * one running straight through it. Shared by both body builders below so
 * the rigid (remote) and live (local) tethers start from the exact same
 * point on the engine.
 */
function tetherEngineAttachLocal(off) {
  return { x: off.x, y: off.y + ENGINE_RADIUS, z: off.z - ENGINE_LENGTH / 2 };
}

/**
 * Rigid single-group body (engines + power couplings + pod + tethers, all
 * at fixed relative transforms) - used for remote players, who only ever
 * replicate one interpolated pose for the whole vehicle over the network,
 * so there's nothing to drive a second (pod) body with there anyway.
 */
function buildBody(chassisWidth, chassisLength, color = DEFAULT_BODY_COLOR, engineCount) {
  const group = new THREE.Group();
  const engineOffsets = engineLocalOffsets(engineCount);

  engineOffsets.forEach((off) => {
    const engine = buildEngine();
    engine.position.set(off.x, off.y, off.z);
    group.add(engine);
  });

  const sorted = engineOffsets.slice().sort((a, b) => a.x - b.x);
  for (let i = 0; i < sorted.length - 1; i++) {
    const strut = buildStrutMesh(0.05, couplingMat);
    orientStrut(strut, sorted[i], sorted[i + 1]);
    group.add(strut);
  }

  const { group: podGroup, bodyMat } = buildPod(color);
  podGroup.position.set(POD_LOCAL_OFFSET.x, POD_LOCAL_OFFSET.y, POD_LOCAL_OFFSET.z);
  group.add(podGroup);

  engineOffsets.forEach((off) => {
    const tether = buildStrutMesh(0.025, tetherMat);
    orientStrut(tether, tetherEngineAttachLocal(off), POD_LOCAL_OFFSET);
    group.add(tether);
  });

  return { group, bodyMat };
}

/**
 * Local-player rig: one rigid THREE.Group holding every engine + the power
 * couplings between them (added to `scene` by the caller, then driven 1:1
 * every frame by a single physics body - see chariot.js's chassisBody) -
 * deliberately NOT split into one mesh per engine any more, so there is
 * exactly one transform for "where the engines visibly are", and the
 * tether physics can anchor to that exact transform instead of a separate
 * reference body the real engines only approximately track. The pod
 * (its own group) and the live tether meshes (re-oriented every frame
 * from the engine group's current transform to the pod's) are returned
 * alongside it, pre-built but **not** pre-positioned - the caller
 * positions everything once it knows each body's current transform.
 */
function buildLocalRig(scene, color = DEFAULT_BODY_COLOR, engineCount) {
  const engineOffsets = engineLocalOffsets(engineCount);

  const engineGroup = new THREE.Group();
  engineOffsets.forEach((off) => {
    const engine = buildEngine();
    engine.position.set(off.x, off.y, off.z);
    engineGroup.add(engine);
  });

  const sorted = engineOffsets.slice().sort((a, b) => a.x - b.x);
  for (let i = 0; i < sorted.length - 1; i++) {
    const strut = buildStrutMesh(0.05, couplingMat);
    orientStrut(strut, sorted[i], sorted[i + 1]);
    engineGroup.add(strut);
  }
  scene.add(engineGroup);

  const { group: podGroup, bodyMat } = buildPod(color);
  scene.add(podGroup);

  const tetherAttachLocal = engineOffsets.map((off) => {
    const attach = tetherEngineAttachLocal(off);
    return new THREE.Vector3(attach.x, attach.y, attach.z);
  });
  const tetherMeshes = engineOffsets.map(() => {
    const tether = buildStrutMesh(0.025, tetherMat);
    scene.add(tether);
    return tether;
  });

  return { engineGroup, podGroup, bodyMat, tetherMeshes, tetherAttachLocal };
}

/**
 * Factory so new pod-racer variants (different engine counts) can be
 * registered later as one-liners instead of duplicating this whole file -
 * see lib/chariot.js, which reads `engineCount` off the descriptor to
 * build the matching physics rig.
 */
function createPodRacerVehicle(engineCount, { id, name } = {}) {
  return {
    id: id ?? `pod-racer-${engineCount}`,
    name: name ?? `Pod Racer (${engineCount} engines)`,
    category: 'chariots-of-fire',
    defaultColor: DEFAULT_BODY_COLOR,
    // Tells lib/car.js's createCar/createRemoteCar to build the hover
    // rig (lib/chariot.js) instead of the wheeled RaycastVehicle rig.
    vehicleType: 'hover',
    engineCount,
    buildBody: (chassisWidth, chassisLength, color) => buildBody(chassisWidth, chassisLength, color, engineCount),
    buildLocalRig: (scene, color) => buildLocalRig(scene, color, engineCount),
  };
}


// Demo variant requested for launch: 3 engines. Other engine counts can be
// added later with `createPodRacerVehicle(n)` - no other file needs to
// change (see ./index.js's VEHICLES list).
export default createPodRacerVehicle(3);

export { createPodRacerVehicle, orientStrut };
