// "Chariots of Fire" pod racer descriptor + visuals (physics: ../chariot.js).
// Jet engines in a row, driver pod tethered behind. Two body builders:
//  - buildBody(): one rigid group, for remote players (one replicated pose);
//  - buildIndependentRig(): one group per engine plus pod, struts and
//    tethers, each driven by its own physics body, for the local player.
// createPodRacerVehicle(n) makes variants with other engine counts.

import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './geometry/paint.js';
import {
  ENGINE_RADIUS,
  ENGINE_LENGTH,
  POD_RADIUS,
  POD_LENGTH,
  engineLocalOffsets,
  POD_LOCAL_OFFSET,
} from './podRacerLayout.js';

// Tuning (read by chariot.js).
const ENGINE_THRUST_FORCE = 64000; // N per engine at full throttle
const MASS = 2100; // kg total, split across engines
// CdA (m^2) per body; small because chariot.js's linearDamping does most of the
// slowing. Broadside (whole row + pod + struts) is by far the draggiest direction.
const DRAG_PROFILE = { front: 0.04, side: 0.149, rear: 0.049 };

const DEFAULT_BODY_COLOR = 0xff6a1a; // flame orange

const engineBodyMat = new THREE.MeshStandardMaterial({ color: 0x8a8d93, metalness: 0.8, roughness: 0.35, flatShading: true });
const engineGlowMat = new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xff6a00, emissiveIntensity: 1.4, roughness: 0.3, flatShading: true });
const couplingMat = new THREE.MeshStandardMaterial({ color: 0x3fb8ff, emissive: 0x1e6f99, emissiveIntensity: 0.9, roughness: 0.25, flatShading: true });
const tetherMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.3, roughness: 0.7, flatShading: true });
const podGlassMat = createGlossyMaterial({ color: 0x141a20, metalness: 0.6, roughness: 0.15 });

/** Jet engine along local Z (nose +Z) with a glowing rear nozzle. */
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

/** Driver pod + cockpit glass, centred on its own origin. */
function buildPod(color) {
  const group = new THREE.Group();
  const podMat = createPaintMaterial(color, { metalness: 0.3, roughness: 0.5 });

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

/** Unit-length cylinder, re-aimed each frame by orientStrut(). */
function buildStrutMesh(radius, material) {
  const geo = new THREE.CylinderGeometry(radius, radius, 1, 6);
  return new THREE.Mesh(geo, material);
}

/** Positions/stretches a strut mesh to run from `from` to `to`. */
function orientStrut(mesh, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dy, dz) || 0.0001;
  mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  mesh.scale.set(1, length, 1);
  mesh.quaternion.setFromUnitVectors(STRUT_UP, new THREE.Vector3(dx, dy, dz).normalize());
}

/** Tether attach point on an engine: rear-top of the housing. */
function tetherEngineAttachLocal(off) {
  return { x: off.x, y: off.y + ENGINE_RADIUS, z: off.z - ENGINE_LENGTH / 2 };
}

const TETHER_SEGMENT_COUNT = 3;

/** Segments of one tether, so it can sag when slack. */
function buildTetherChain() {
  return Array.from({ length: TETHER_SEGMENT_COUNT }, () => buildStrutMesh(0.025, tetherMat));
}

// Scratch interior joints, fully recomputed per orientTetherChain call.
const tetherChainJoints = Array.from({ length: TETHER_SEGMENT_COUNT - 1 }, () => new THREE.Vector3());

/** Lays segments from `from` to `to`, drooping the middle by up to `sag` m (parabola). */
function orientTetherChain(segments, from, to, sag = 0) {
  const n = segments.length;
  const joints = [from, ...tetherChainJoints, to];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const droop = sag * 4 * t * (1 - t); // parabola: 0 at t=0/1, `sag` at t=0.5
    joints[i].set(
      from.x + (to.x - from.x) * t,
      from.y + (to.y - from.y) * t - droop,
      from.z + (to.z - from.z) * t
    );
  }
  for (let i = 0; i < n; i++) orientStrut(segments[i], joints[i], joints[i + 1]);
}

/** Rigid single-group body for remote players. */
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
    const tether = buildTetherChain();
    // No slack info for a remote pose: straight tether.
    orientTetherChain(tether, tetherEngineAttachLocal(off), POD_LOCAL_OFFSET, 0);
    tether.forEach((segment) => group.add(segment));
  });

  return { group, bodyMat };
}

/**
 * Local-player rig: one group per engine, coupling struts (couplingPairs
 * = engine index pairs, adjacent by local x), a pod group and tether
 * chains - all added to `scene` and posed each frame by chariot.js.
 */
function buildIndependentRig(scene, color = DEFAULT_BODY_COLOR, engineCount) {
  const engineOffsets = engineLocalOffsets(engineCount);

  const engineMeshes = engineOffsets.map(() => {
    const engine = buildEngine();
    scene.add(engine);
    return engine;
  });

  // Adjacent engines by local x get a strut.
  const sortedIndices = engineOffsets
    .map((off, i) => i)
    .sort((a, b) => engineOffsets[a].x - engineOffsets[b].x);
  const couplingPairs = [];
  const couplingMeshes = [];
  for (let i = 0; i < sortedIndices.length - 1; i++) {
    couplingPairs.push([sortedIndices[i], sortedIndices[i + 1]]);
    const strut = buildStrutMesh(0.05, couplingMat);
    scene.add(strut);
    couplingMeshes.push(strut);
  }

  const { group: podGroup, bodyMat } = buildPod(color);
  scene.add(podGroup);

  // Relative to the engine's own origin (each engine mesh is placed in
  // world space), so no formation offset here.
  const localAttach = tetherEngineAttachLocal({ x: 0, y: 0, z: 0 });
  const tetherAttachLocal = engineOffsets.map(() => new THREE.Vector3(localAttach.x, localAttach.y, localAttach.z));
  const tetherMeshes = engineOffsets.map(() => {
    const tether = buildTetherChain();
    tether.forEach((segment) => scene.add(segment));
    return tether;
  });

  return { engineMeshes, couplingMeshes, couplingPairs, podGroup, bodyMat, tetherMeshes, tetherAttachLocal };
}

/** Descriptor for a pod racer with `engineCount` engines. */
function createPodRacerVehicle(engineCount, { id, name, engineThrustForce, mass } = {}) {
  return {
    id: id ?? `pod-racer-${engineCount}`,
    name: name ?? `Pod Racer (${engineCount} engines)`,
    category: 'chariots-of-fire',
    defaultColor: DEFAULT_BODY_COLOR,
    vehicleType: 'hover', // car.js dispatches to chariot.js
    scoresAirtime: false,
    engineCount,
    engineThrustForce: engineThrustForce ?? ENGINE_THRUST_FORCE,
    mass: mass ?? MASS,
    buildBody: (chassisWidth, chassisLength, color) => buildBody(chassisWidth, chassisLength, color, engineCount),
    buildIndependentRig: (scene, color) => buildIndependentRig(scene, color, engineCount),
    dragProfile: DRAG_PROFILE,
  };
}


// The registered variant; add others with createPodRacerVehicle(n).
export default createPodRacerVehicle(3);

export { createPodRacerVehicle, orientStrut, orientTetherChain };
