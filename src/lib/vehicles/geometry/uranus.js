import * as THREE from 'three';
import { createPaintMaterial } from './paint.js';
import { buildCab, rearMudguard, truckMaterials } from './euroCab.js';
import { createKit } from './kit.js';

// Uranus T1500 4x2 tractor with a 13.6 m curtainsider semi-trailer,
// low-poly. Both chassis-local with the origin at the centre of mass
// (~1.1 m above the ground at rest), +z forward. Axle / hitch positions
// must match ../uranus.js.

const FRONT_AXLE_Z = 2.0;
const REAR_AXLE_Z = -1.8;
const HITCH_Z = -1.55;
const TRAILER_AXLES_Z = [-1.9, -3.2, -4.5];

/** Tractor unit; `color` paints the cab. */
export function buildBody(_chassisWidth, _chassisLength, color = 0xb3131b) {
  const group = new THREE.Group();
  const m = truckMaterials();
  const bodyMat = createPaintMaterial(color, { metalness: 0.3, roughness: 0.45 });
  const kit = createKit(group);
  const { add, box, tube } = kit;

  buildCab(kit, m, bodyMat, { front: 3.4, depth: 2.3, axleZ: FRONT_AXLE_Z, roofY: 2.75, grille: 'slatted' });

  // Ladder frame, fifth wheel (plate top = hitch height 0.15).
  for (const sx of [-1, 1]) box(0.22, 0.28, 6.0, m.frame, sx * 0.45, -0.3, 0.2);
  box(1.3, 0.2, 1.1, m.frame, 0, -0.06, HITCH_Z);
  add(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 18), m.steel, 0, 0.11, HITCH_Z);
  box(0.25, 0.04, 0.5, m.frame, 0, 0.16, HITCH_Z - 0.3); // coupling throat

  // Behind the cab: air lines, chrome exhaust stack, catwalk.
  box(1.0, 0.05, 0.6, m.steel, 0, -0.1, 0.75);
  add(new THREE.CylinderGeometry(0.09, 0.09, 1.9, 12), m.chrome, -1.1, 1.1, 0.95);
  for (const sx of [-1, 1]) tube(0.025, 0.6, sx > 0 ? m.amber : m.tail, sx * 0.15, 0.05, 0.55, 8).rotation.x = 0.6;

  // Between the axles: fuel tank (left), AdBlue + battery box (right), side skirts.
  tube(0.33, 1.5, m.steel, 0.95, -0.45, 0.25);
  tube(0.24, 0.5, m.steel, -0.95, -0.5, 0.75);
  box(0.6, 0.55, 0.8, m.plastic, -0.95, -0.45, -0.15);
  for (const sx of [-1, 1]) box(0.04, 0.4, 2.2, bodyMat, sx * 1.25, -0.6, 0.15);

  // Rear: mudguards over the duals, light bar on the frame end.
  for (const sx of [-1, 1]) {
    rearMudguard(kit, m, sx * 0.95, REAR_AXLE_Z);
    box(0.3, 0.1, 0.04, m.tail, sx * 0.7, -0.4, -2.83);
  }
  box(2.0, 0.16, 0.12, m.frame, 0, -0.4, -2.75);

  return { group, bodyMat };
}

/** Curtainsider trailer, 13.6 x 2.55 m; `color` paints the curtains. Kingpin at z = 5.6, y = 0.15. */
export function buildTrailer(color = 0xb3131b) {
  const group = new THREE.Group();
  const m = truckMaterials();
  const curtainMat = createPaintMaterial(color, { metalness: 0.05, roughness: 0.8 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e4, metalness: 0.2, roughness: 0.6 });
  const kit = createKit(group);
  const { box } = kit;

  const front = 6.8;
  const back = -6.8;
  const len = front - back;
  const width = 2.55;
  const half = width / 2;
  const floorY = 0.15;
  const topY = 2.95;
  const bodyH = topY - floorY - 0.15;
  const bodyY = floorY + 0.15 + bodyH / 2;

  // Chassis beams, floor deck, landing legs.
  for (const sx of [-1, 1]) box(0.2, 0.35, len - 0.4, m.frame, sx * 0.5, floorY - 0.18, 0);
  box(width, 0.15, len, m.frame, 0, floorY + 0.075, 0);
  for (const sx of [-1, 1]) {
    box(0.12, 0.85, 0.12, m.steel, sx * 0.9, -0.45, 4.2);
    box(0.3, 0.05, 0.3, m.frame, sx * 0.9, -0.88, 4.2);
  }

  // Box: white front wall + roof, side curtains with tension straps, rear doors.
  box(width, bodyH, 0.08, whiteMat, 0, bodyY, front - 0.04);
  box(width, 0.08, len, whiteMat, 0, topY - 0.04, 0);
  for (const sx of [-1, 1]) {
    box(0.04, bodyH - 0.1, len - 0.2, curtainMat, sx * (half - 0.02), bodyY, 0);
    box(0.06, 0.12, len, m.steel, sx * (half - 0.01), floorY + 0.21, 0); // rave rail
    for (let z = back + 0.6; z < front - 0.3; z += 0.6) box(0.05, 0.08, 0.04, m.frame, sx * half, floorY + 0.35, z);
    box(0.08, bodyH, 0.1, whiteMat, sx * (half - 0.03), bodyY, front - 0.05); // corner posts
    box(0.08, bodyH, 0.1, whiteMat, sx * (half - 0.03), bodyY, back + 0.05);
  }
  for (const sx of [-1, 1]) {
    box(half - 0.04, bodyH - 0.06, 0.05, whiteMat, sx * (half / 2), bodyY, back - 0.01);
    for (const y of [0.9, 2.2]) box(0.05, 0.05, 0.06, m.steel, sx * 0.08, y, back - 0.04); // lock bars
    box(0.04, bodyH - 0.2, 0.04, m.steel, sx * 0.08, bodyY, back - 0.04);
  }

  // Running gear: tri-axle mudguards, side under-run bars, rear bumper and lamps.
  const bogieZ = (TRAILER_AXLES_Z[0] + TRAILER_AXLES_Z[2]) / 2;
  for (const sx of [-1, 1]) {
    rearMudguard(kit, m, sx * 1.0, bogieZ, 3.9);
    box(0.04, 0.08, 4.0, m.steel, sx * (half - 0.05), -0.35, 1.6);
    box(0.04, 0.08, 4.0, m.steel, sx * (half - 0.05), -0.6, 1.6);
    for (let z = -5.5; z <= 5.5; z += 2.2) box(0.05, 0.08, 0.04, m.amber, sx * (half + 0.01), floorY + 0.05, z);
    box(0.4, 0.14, 0.05, m.tail, sx * 0.95, -0.2, back - 0.05);
    box(0.12, 0.14, 0.05, m.amber, sx * 0.6, -0.2, back - 0.05);
  }
  box(2.3, 0.12, 0.12, m.steel, 0, -0.55, back + 0.2); // under-run guard
  box(0.6, 0.05, 0.12, m.frame, 0, floorY, front - 1.2); // kingpin plate

  return { group, bodyMat: curtainMat };
}
