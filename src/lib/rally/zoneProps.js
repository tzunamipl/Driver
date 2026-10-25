// Roadside props per rally point type: marshal / timekeeper tents, timing hut, refuel kit,
// tyre stacks, barriers, cones, chairs. Each builder returns a Group in the control's frame:
// local +z faces back along travel, local +x points away from the road. Visual only.
// bakeProps merges a set into one vertex-coloured, shadow-casting mesh, like the roadside kinds.
// Parts spread far along the road go in userData.loose instead: each is placed on the terrain under it.

import { BoxGeometry, BufferAttribute, ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const TENT_LEG_M = 2.1;
// rotY that turns a chair (facing local +z) to face the road at local -x.
const FACE_ROAD = -Math.PI / 2;

function shared(thing) {
  thing.userData.shared = true;
  return thing;
}

// Palette only: never rendered, bakeProps turns each into vertex colours.
const paint = (color) => new MeshBasicMaterial({ color });
const mat = {
  red: paint(0xc81e1e),
  darkRed: paint(0x7a1010),
  blue: paint(0x1f4fa8),
  black: paint(0x161616),
  rubber: paint(0x1c1c1c),
  steel: paint(0x9a9a9a),
  white: paint(0xf2f2f2),
  yellow: paint(0xf2c200),
  orange: paint(0xff6a00),
  purple: paint(0x7b3fe0),
  glass: paint(0x203040),
};
const propMaterial = shared(new MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));

const tyreGeometry = shared(new CylinderGeometry(0.33, 0.33, 0.22, 14));
const rimGeometry = shared(new CylinderGeometry(0.2, 0.2, 0.23, 10));
const drumGeometry = shared(new CylinderGeometry(0.29, 0.29, 0.88, 12));
const canGeometry = shared(new BoxGeometry(0.17, 0.45, 0.34));
const legGeometry = shared(new CylinderGeometry(0.035, 0.035, TENT_LEG_M, 5));
const thinLegGeometry = shared(new CylinderGeometry(0.025, 0.025, 0.72, 4));
const coneGeometry = shared(new ConeGeometry(0.15, 0.5, 10));
const coneBandGeometry = shared(new CylinderGeometry(0.095, 0.115, 0.08, 10));

/** One mesh for a builder's Group: parts transformed, painted with their palette colour, merged. */
export function bakeProps(group) {
  group.updateMatrixWorld(true);
  const parts = [];
  group.traverse((obj) => {
    if (!obj.isMesh) return;
    const geometry = obj.geometry.clone().applyMatrix4(obj.matrixWorld);
    const { r, g, b } = obj.material.color;
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) colors.set([r, g, b], i);
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    parts.push(geometry);
    if (!obj.geometry.userData.shared) obj.geometry.dispose();
  });
  const mesh = new Mesh(mergeGeometries(parts), propMaterial);
  for (const part of parts) part.dispose();
  mesh.castShadow = true;
  return mesh;
}

function box(w, h, d, material, x, y, z) {
  const mesh = new Mesh(new BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  return mesh;
}

function at(mesh, x, y, z, rotY = 0) {
  mesh.position.set(x, y, z);
  mesh.rotation.y = rotY;
  return mesh;
}

/** Tyre lying flat (with its rim) centred at x, y, z. */
function flatTyre(x, y, z) {
  const group = new Group();
  group.add(new Mesh(tyreGeometry, mat.rubber), new Mesh(rimGeometry, mat.steel));
  group.position.set(x, y, z);
  return group;
}

/** Tyre standing on its tread, axle along local z. */
function uprightTyre(x, z) {
  const tyre = flatTyre(x, 0.33, z);
  tyre.rotation.x = Math.PI / 2;
  return tyre;
}

function tyreStack(x, z, count) {
  const group = new Group();
  for (let i = 0; i < count; i++) group.add(flatTyre(x + (i % 2) * 0.03, 0.11 + i * 0.22, z));
  return group;
}

/** Square pop-up tent: four legs, peaked roof, a coloured valance round the edge. */
function popUpTent(size, roofMaterial, valanceMaterial) {
  const group = new Group();
  const h = size / 2 - 0.05;
  for (const [x, z] of [[-h, -h], [h, -h], [-h, h], [h, h]]) group.add(at(new Mesh(legGeometry, mat.steel), x, TENT_LEG_M / 2, z));
  // 4-sided cone turned 45° = pyramid roof.
  const roof = new Mesh(new ConeGeometry(size * Math.SQRT1_2, size * 0.3, 4, 1), roofMaterial);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = TENT_LEG_M + size * 0.15;
  group.add(roof);
  const v = 0.22;
  const y = TENT_LEG_M - v / 2;
  group.add(
    box(size, v, 0.03, valanceMaterial, 0, y, h),
    box(size, v, 0.03, valanceMaterial, 0, y, -h),
    box(0.03, v, size, valanceMaterial, h, y, 0),
    box(0.03, v, size, valanceMaterial, -h, y, 0)
  );
  return group;
}

function table(x, z, width, rotY = 0) {
  const group = new Group();
  group.add(box(width, 0.04, 0.7, mat.white, 0, 0.74, 0));
  for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    group.add(at(new Mesh(thinLegGeometry, mat.steel), lx * (width / 2 - 0.06), 0.36, lz * 0.29));
  }
  return at(group, x, 0, z, rotY);
}

function cone(x, z) {
  const mesh = new Mesh(coneGeometry, mat.orange);
  mesh.position.set(x, 0.25, z);
  mesh.add(at(new Mesh(coneBandGeometry, mat.white), 0, 0.02, 0));
  return mesh;
}

/** Steel crowd barrier section along local z, `length` long. */
function crowdBarrier(x, z, length = 2.2) {
  const group = new Group();
  group.add(box(0.04, 0.04, length, mat.steel, 0, 1.05, 0), box(0.04, 0.04, length, mat.steel, 0, 0.2, 0));
  for (let i = 0; i <= 8; i++) group.add(box(0.02, 0.85, 0.02, mat.steel, 0, 0.62, -length / 2 + (i * length) / 8));
  for (const end of [-1, 1]) group.add(box(0.6, 0.04, 0.05, mat.steel, 0, 0.02, (end * length) / 2));
  return at(group, x, 0, z);
}

/** Small flag on a pole: cloth towards local -z. */
function poleFlag(x, z, material, height = 2.6) {
  const group = new Group();
  group.add(at(new Mesh(new CylinderGeometry(0.03, 0.03, height, 5), mat.steel), 0, height / 2, 0));
  group.add(box(0.02, 0.5, 0.8, material, 0, height - 0.3, -0.42));
  return at(group, x, 0, z);
}

function chair(x, z, rotY) {
  const group = new Group();
  group.add(box(0.45, 0.04, 0.45, mat.blue, 0, 0.45, 0), box(0.45, 0.45, 0.04, mat.blue, 0, 0.7, -0.21));
  for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const leg = at(new Mesh(thinLegGeometry, mat.steel), lx * 0.19, 0.22, lz * 0.19);
    leg.scale.y = 0.62;
    group.add(leg);
  }
  return at(group, x, 0, z, rotY);
}

/** Refuel zone: fuel bowser with hose, jerrycans, oil drums, a fire extinguisher. */
export function makeRefuelProps() {
  const group = new Group();
  // Bowser: tank on a steel skid, end facing the road.
  group.add(box(1.4, 0.15, 2.2, mat.steel, 1.2, 0.075, 0));
  group.add(box(1.2, 1.3, 2.0, mat.red, 1.2, 0.8, 0));
  group.add(box(1.22, 0.12, 2.02, mat.white, 1.2, 1.2, 0)); // stripe
  group.add(box(0.5, 0.6, 0.06, mat.white, 0.58, 0.95, 0.4)); // pump display on the road side
  const hose = new Mesh(new CylinderGeometry(0.035, 0.035, 1.1, 6), mat.black);
  hose.rotation.z = Math.PI / 2.6;
  hose.position.set(0.25, 0.55, -0.3);
  group.add(hose);
  // Jerrycans, 2 x 2 and one on top.
  for (const [x, y, z] of [[0.3, 0.225, 1.6], [0.5, 0.225, 1.6], [0.3, 0.225, 1.98], [0.5, 0.225, 1.98], [0.4, 0.675, 1.79]]) {
    group.add(at(new Mesh(canGeometry, mat.red), x, y, z));
  }
  for (const [x, z, material] of [[1.0, -1.7, mat.blue], [1.65, -1.75, mat.blue], [1.3, -2.3, mat.darkRed]]) {
    group.add(at(new Mesh(drumGeometry, material), x, 0.44, z));
  }
  const extinguisher = at(new Mesh(new CylinderGeometry(0.08, 0.08, 0.5, 8), mat.red), 0.2, 0.25, -1.0);
  extinguisher.add(at(new Mesh(new CylinderGeometry(0.03, 0.05, 0.1, 6), mat.black), 0, 0.3, 0));
  group.add(extinguisher);
  return group;
}

/** Tyre fitting zone: small canopy over a wheel rack, tyre stacks beside it. */
export function makeTyreProps() {
  const group = new Group();
  const canopy = popUpTent(3, mat.black, mat.yellow);
  canopy.position.set(1.6, 0, 0);
  group.add(canopy);
  // Rack: steel frame with tyres standing in it, under the canopy.
  group.add(box(0.06, 0.9, 2.4, mat.steel, 2.6, 0.45, 0), box(0.5, 0.06, 2.4, mat.steel, 2.4, 0.06, 0));
  for (let i = 0; i < 5; i++) group.add(uprightTyre(2.35, -0.95 + i * 0.47));
  group.add(tyreStack(0.6, 2.0, 4), tyreStack(1.35, 2.1, 5), tyreStack(0.95, 2.75, 3), tyreStack(0.7, -2.0, 4));
  return group;
}

/** Tent placed at x, z with whatever stands under it. */
function tentWith(x, z, size, roof, valance, contents = []) {
  const group = new Group();
  group.add(popUpTent(size, roof, valance), ...contents);
  return at(group, x, 0, z);
}

/** Rally base: a row of pop-up tents along the road: rally office, two team tents, a service tent. */
export function makeBaseTent() {
  const group = new Group();
  group.add(
    tentWith(1.5, 0, 3, mat.white, mat.blue, [table(0, -0.4, 1.6), chair(-0.4, 0.15, Math.PI), chair(0.4, 0.15, Math.PI)]),
    tentWith(1.5, -3.6, 3, mat.white, mat.red, [table(0.3, 0, 1.4, Math.PI / 2), chair(-0.4, 0, FACE_ROAD)]),
    tentWith(1.2, -6.8, 2.2, mat.white, mat.yellow, [chair(0, 0, FACE_ROAD)]),
    tentWith(2, 4.2, 4, mat.blue, mat.white, [tyreStack(0.8, -1, 4), tyreStack(0.8, -0.2, 3), box(0.6, 0.45, 0.35, mat.red, 0.6, 0.225, 1)])
  );
  return group;
}

/** Marshal post at a stop control (TC, STOP): small tent, table and chair facing the road. */
export function makeMarshalTent() {
  const group = new Group();
  const tent = popUpTent(2.2, mat.white, mat.red);
  tent.position.x = 1.3;
  group.add(tent, table(0.9, 0, 1.2, Math.PI / 2), chair(1.55, 0, FACE_ROAD));
  return group;
}

/** Timekeepers at the flying finish: tent with a table and two chairs facing the road. */
export function makeTimekeeperTent() {
  const group = new Group();
  const tent = popUpTent(3, mat.white, mat.red);
  tent.position.x = 1.6;
  group.add(tent, table(1.1, 0, 1.6, Math.PI / 2), chair(1.75, -0.4, FACE_ROAD), chair(1.75, 0.4, FACE_ROAD));
  return group;
}

/** Start timing hut: white cabin with a window towards the road. */
export function makeTimingHut() {
  const group = new Group();
  group.add(box(1.6, 2.2, 1.8, mat.white, 1.0, 1.1, 0), box(1.9, 0.12, 2.1, mat.steel, 1.0, 2.26, 0));
  group.add(box(0.03, 0.6, 0.7, mat.glass, 0.19, 1.45, -0.4), box(0.03, 1.8, 0.7, mat.steel, 0.19, 0.9, 0.5)); // window, door
  group.add(at(new Mesh(new CylinderGeometry(0.015, 0.015, 1.2, 4), mat.black), 1.5, 2.9, -0.6)); // antenna
  return group;
}

/** Split timing: small box on a tripod with a beam towards the road. */
export function makeSplitBox() {
  const group = new Group();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = at(new Mesh(new CylinderGeometry(0.015, 0.015, 1.15, 4), mat.black), 0.6 + Math.cos(a) * 0.15, 0.55, Math.sin(a) * 0.15);
    leg.rotation.set(Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25);
    group.add(leg);
  }
  group.add(box(0.3, 0.25, 0.2, mat.yellow, 0.6, 1.2, 0), box(0.04, 0.08, 0.08, mat.glass, 0.44, 1.2, 0));
  return group;
}

/** Passage control: a stand of rolled-up signal flags. */
export function makePassageProps() {
  const group = new Group();
  group.add(box(0.25, 0.6, 0.25, mat.steel, 0.6, 0.3, 0.7));
  for (const [dz, material] of [[-0.06, mat.yellow], [0.06, mat.red], [0, mat.blue]]) {
    group.add(at(new Mesh(new CylinderGeometry(0.03, 0.03, 0.9, 5), material), 0.6 + dz, 1.0, 0.7 + dz));
  }
  return group;
}

/** Service park entry / exit: raised striped barrier boom and a row of cones. */
export function makeServiceGate() {
  const group = new Group();
  group.add(box(0.2, 1.1, 0.2, mat.white, 0.3, 0.55, 0));
  // Boom raised at 75°, red and white segments.
  const boom = new Group();
  for (let i = 0; i < 6; i++) boom.add(box(0.08, 0.6, 0.08, i % 2 ? mat.white : mat.red, 0, 0.3 + i * 0.6, 0));
  boom.position.set(0.3, 1.0, 0);
  boom.rotation.x = -Math.PI / 12;
  group.add(boom);
  group.userData.loose = [];
  for (let i = 0; i < 5; i++) group.userData.loose.push(cone(0.1, 1.5 + i * 1.6), cone(0.1, -1.5 - i * 1.6));
  return group;
}

/** Regroup: a row of chairs and a water barrel. */
export function makeRegroupProps() {
  const group = new Group();
  for (let i = 0; i < 4; i++) group.add(chair(1.2, -1.2 + i * 0.7, FACE_ROAD));
  group.add(at(new Mesh(drumGeometry, mat.blue), 1.3, 0.44, 1.9));
  return group;
}

/** Service park bay: a big team awning over a workbench and tool chest, jack, spare wheels and cones. */
export function makeServiceProps() {
  const group = new Group();
  const awning = popUpTent(5, mat.red, mat.white);
  awning.position.x = 2.8;
  group.add(awning);
  group.add(box(2.0, 0.9, 0.7, mat.steel, 4.6, 0.45, 0)); // workbench
  group.add(box(0.7, 1.1, 0.5, mat.red, 4.6, 0.55, 1.7), box(0.6, 0.45, 0.35, mat.black, 4.6, 1.33, -1.6)); // tool chest, toolbox
  group.add(box(0.8, 0.15, 0.3, mat.steel, 1.6, 0.075, 0.9), box(0.1, 0.12, 0.25, mat.black, 1.25, 0.2, 0.9)); // trolley jack
  group.add(uprightTyre(3.4, 2.0), uprightTyre(3.4, 2.25), uprightTyre(3.8, 2.0), tyreStack(3.8, -2.0, 3));
  group.add(cone(0.4, -2.6), cone(0.4, 2.6));
  return group;
}

/** Remote service: canopy over a toolbox, a jack and two spare tyres. */
export function makeRemoteServiceProps() {
  const group = new Group();
  const canopy = popUpTent(3, mat.blue, mat.white);
  canopy.position.x = 1.6;
  group.add(canopy);
  group.add(box(0.6, 0.45, 0.35, mat.red, 2.3, 0.225, -0.8)); // toolbox
  group.add(box(0.8, 0.15, 0.3, mat.steel, 1.2, 0.075, 0.6), box(0.1, 0.12, 0.25, mat.black, 0.85, 0.2, 0.6)); // trolley jack
  group.add(uprightTyre(2.6, 0.5), uprightTyre(2.6, 0.75));
  return group;
}

/** Parc fermé: steel crowd barriers along the road and two flags. */
export function makeParcFermeProps() {
  const group = new Group();
  for (let i = -2; i <= 2; i++) group.add(crowdBarrier(0.3, i * 2.3));
  group.add(poleFlag(0.8, -6, mat.blue), poleFlag(0.8, 6, mat.blue));
  return group;
}

/** Podium: stepped 1-2-3 podium behind crowd barriers. */
export function makePodiumProps() {
  const group = new Group();
  for (let i = -1; i <= 1; i++) group.add(crowdBarrier(0.3, i * 2.3));
  for (const [z, h] of [[0, 0.9], [-1.1, 0.6], [1.1, 0.4]]) group.add(box(1.0, h, 1.1, mat.white, 2.0, h / 2, z));
  group.add(box(0.03, 0.18, 1.0, mat.yellow, 1.49, 0.75, 0)); // "1" panel on the top step
  group.add(poleFlag(2.9, -1.6, mat.yellow, 3), poleFlag(2.9, 1.6, mat.purple, 3));
  return group;
}
