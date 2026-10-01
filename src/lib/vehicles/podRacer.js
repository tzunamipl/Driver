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
//  - buildIndependentBody(): separate meshes for every engine, every
//    coupling strut, and the pod, each meant to be driven by its own
//    physics body - used for the *local* player's chariot
//    (lib/chariot.js), where the engines flex independently and the
//    tether's slack is real.

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
 * `orientStrut` (below) rather than rebuilt - used for both the power
 * couplings (set once, static) and the tethers (updated live every frame,
 * since the pod isn't rigidly fixed relative to the engines any more).
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
    // Same rear-top attach point as the independent (local-player) body -
    // see TETHER_ENGINE_LOCAL_OFFSET in chariot.js for the rationale; kept
    // in sync here by hand since this rigid body has no per-engine
    // quaternion of its own to rotate an offset through (engines never
    // move relative to the group), so it's simplest to just add the
    // offset directly in this shared local frame (+Z front, nose convention
    // from buildEngine()).
    const attach = { x: off.x, y: off.y + ENGINE_RADIUS, z: off.z - ENGINE_LENGTH / 2 };
    orientStrut(tether, attach, POD_LOCAL_OFFSET);
    group.add(tether);
  });

  return { group, bodyMat };
}

/**
 * Independent body for the local, physics-driven chariot (lib/chariot.js)
 * with genuinely independent engine bodies (see ENGINE_FORMATION_* in
 * chariot.js): each engine gets its own standalone mesh (added directly
 * to `scene`, not nested in one shared group, since each is now driven by
 * its own physics body and can visibly flex apart from the others) and
 * the power-coupling struts between them become dynamic meshes
 * (`couplingMeshes`, re-aimed every frame via `orientStrut`) instead of
 * static children, since the engines can now actually drift relative to
 * each other. Also returns `tetherMeshes` (one per engine) and `podGroup`,
 * pre-built but **not** pre-oriented - the caller repositions everything
 * every frame once it knows each body's current transform.
 */
function buildIndependentBody(scene, color = DEFAULT_BODY_COLOR, engineCount) {
  const engineOffsets = engineLocalOffsets(engineCount);

  const engineMeshes = engineOffsets.map((off) => {
    const engine = buildEngine();
    engine.position.set(off.x, off.y, off.z);
    scene.add(engine);
    return engine;
  });

  const couplingOrder = engineOffsets
    .map((off, index) => ({ off, index }))
    .sort((a, b) => a.off.x - b.off.x)
    .map((entry) => entry.index);
  const couplingMeshes = [];
  for (let i = 0; i < couplingOrder.length - 1; i++) {
    const strut = buildStrutMesh(0.05, couplingMat);
    scene.add(strut);
    couplingMeshes.push(strut);
  }

  const { group: podGroup, bodyMat } = buildPod(color);

  const tetherMeshes = engineOffsets.map(() => {
    const tether = buildStrutMesh(0.025, tetherMat);
    scene.add(tether);
    return tether;
  });

  return { engineMeshes, couplingMeshes, podGroup, tetherMeshes, bodyMat, engineOffsets, couplingOrder };
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
    buildIndependentBody: (scene, color) => buildIndependentBody(scene, color, engineCount),
  };
}


// Demo variant requested for launch: 3 engines. Other engine counts can be
// added later with `createPodRacerVehicle(n)` - no other file needs to
// change (see ./index.js's VEHICLES list).
export default createPodRacerVehicle(3);

export { createPodRacerVehicle, orientStrut };
