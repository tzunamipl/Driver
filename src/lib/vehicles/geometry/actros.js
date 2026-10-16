import * as THREE from 'three';
import { createPaintMaterial } from './paint.js';
import { buildCab, rearMudguard, truckMaterials } from './euroCab.js';
import { createKit } from './kit.js';

// Mercedes-Benz Actros 8x4 tipper, low-poly. Chassis-local, origin at the
// centre of mass (~1.1 m above the ground at rest), +z forward, 9.8 m long.
// Axle positions must match ../actros.js.

const FRONT_AXLES_Z = [3.5, 1.5];
const REAR_AXLES_Z = [-2.3, -3.65];
const FRONT = 4.9;
const BACK = -4.9;

/** `color` paints the cab; the tipper body stays steel grey. */
export function buildBody(_chassisWidth, _chassisLength, color = 0xf2f2f0) {
  const group = new THREE.Group();
  const m = truckMaterials();
  const bodyMat = createPaintMaterial(color, { metalness: 0.3, roughness: 0.45 });
  const tipperMat = new THREE.MeshStandardMaterial({ color: 0x5d6166, metalness: 0.6, roughness: 0.55 });
  const kit = createKit(group);
  const { add, box, tube, fender } = kit;

  buildCab(kit, m, bodyMat, { front: FRONT - 0.05, depth: 2.2, axleZ: FRONT_AXLES_Z[0], roofY: 2.45, grille: 'actros' });

  // Ladder frame; second steer axle's arches + steps behind the cab.
  for (const sx of [-1, 1]) box(0.24, 0.3, 9.4, m.frame, sx * 0.45, -0.3, 0);
  for (const sx of [-1, 1]) {
    fender(0.62, 0.42, m.plastic, sx * 1.02, -0.5, FRONT_AXLES_Z[1]);
    box(0.45, 0.04, 1.2, m.plastic, sx * 1.02, 0.12, FRONT_AXLES_Z[1]);
  }

  // Between the axle groups: fuel tank (left), air tanks + battery box (right).
  tube(0.33, 1.2, m.steel, 0.95, -0.45, -0.5);
  for (const z of [-0.2, -0.85]) tube(0.14, 0.55, m.steel, -0.9, -0.55, z);
  box(0.6, 0.5, 0.55, m.plastic, -0.95, -0.35, -0.5);
  add(new THREE.CylinderGeometry(0.08, 0.08, 1.4, 12), m.steel, -1.05, 0.95, 2.45); // exhaust stack

  // Tipper: subframe, tapered steel body (empty), front ram + cab guard.
  const bodyFront = 2.15;
  const bodyLen = bodyFront - (BACK + 0.05);
  const bodyZ = bodyFront - bodyLen / 2;
  const floorY = 0.38;
  const sideH = 1.35;
  box(1.1, 0.2, bodyLen, m.frame, 0, 0.12, bodyZ);
  box(2.3, 0.12, bodyLen, tipperMat, 0, floorY, bodyZ);
  for (const sx of [-1, 1]) {
    const side = box(0.08, sideH, bodyLen, tipperMat, sx * 1.2, floorY + sideH / 2, bodyZ);
    side.rotation.z = sx * -0.06; // flared out at the top
    for (let i = 0; i < 4; i++) box(0.06, sideH, 0.1, m.frame, sx * 1.27, floorY + sideH / 2, bodyFront - 0.7 - i * 1.6);
    box(0.06, 0.12, bodyLen, m.frame, sx * 1.29, floorY + sideH, bodyZ); // top rail
  }
  box(2.5, sideH + 0.1, 0.1, tipperMat, 0, floorY + sideH / 2 + 0.05, bodyFront);
  box(2.5, 0.08, 0.7, tipperMat, 0, floorY + sideH + 0.12, bodyFront + 0.3); // cab guard
  box(2.4, sideH, 0.1, tipperMat, 0, floorY + sideH / 2, BACK + 0.05); // tailgate
  for (const sx of [-1, 1]) box(0.1, 0.2, 0.2, m.frame, sx * 1.1, floorY + sideH, BACK); // tailgate hinges
  add(new THREE.CylinderGeometry(0.12, 0.12, 1.1, 12), m.chrome, 0, 0.2, bodyFront + 0.15); // hoist ram

  // Rear: mudguards over the tandem duals, light bar.
  const tandemZ = (REAR_AXLES_Z[0] + REAR_AXLES_Z[1]) / 2;
  for (const sx of [-1, 1]) {
    rearMudguard(kit, m, sx * 0.95, tandemZ, 2.7);
    box(0.32, 0.12, 0.05, m.tail, sx * 0.9, -0.35, BACK - 0.08);
    box(0.12, 0.12, 0.05, m.amber, sx * 0.55, -0.35, BACK - 0.08);
  }
  box(2.3, 0.18, 0.12, m.steel, 0, -0.35, BACK);

  return { group, bodyMat };
}
