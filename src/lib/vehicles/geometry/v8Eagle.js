import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { createKit } from './kit.js';

// V8 Eagle (early-70s muscle coupe, pursuit special),
// low-poly. Chassis-local, origin at the centre of mass (~0.75 m above the
// ground at rest), +z forward, 4.7 m long; wheel tops near y = -0.1.
// Axle positions must match ../v8Eagle.js.

const AXLES_Z = [1.4, -1.42];
const ARCH_R = 0.38;
const FRONT = 2.35;
const BACK = -2.35;
const WIDTH = 1.86;

export function buildBody(_chassisWidth, _chassisLength, color = 0x111111) {
  const group = new THREE.Group();
  const bodyMat = createPaintMaterial(color, { metalness: 0.2, roughness: 0.55 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0b0b0b, metalness: 0.2, roughness: 0.8 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd0d0d0, metalness: 0.95, roughness: 0.2 });
  const rust = new THREE.MeshStandardMaterial({ color: 0x5a3a24, metalness: 0.4, roughness: 0.85 });
  const glass = createGlossyMaterial({ color: 0x10151a, metalness: 0.5, roughness: 0.1 });
  const head = createGlossyMaterial({ color: 0xfff4d8, emissive: 0x554417, roughness: 0.25, userData: { lamp: 'head' } });
  const tail = createGlossyMaterial({ color: 0xb0101a, emissive: 0x400000, roughness: 0.3, userData: { lamp: 'tail' } });
  const { add, box, tube, fender, profile } = createKit(group);

  // Lower body with open wheel arches: beltline slab over the wheels, sills
  // and overhangs between them, a narrow tub inside.
  box(WIDTH, 0.24, FRONT - BACK, bodyMat, 0, 0, 0);
  const [fz, rz] = AXLES_Z;
  const sill = (z0, z1) => box(WIDTH, 0.36, z0 - z1, bodyMat, 0, -0.3, (z0 + z1) / 2);
  sill(FRONT, fz + ARCH_R);
  sill(fz - ARCH_R, rz + ARCH_R);
  sill(rz - ARCH_R, BACK);
  box(1.3, 0.36, FRONT - BACK, black, 0, -0.3, 0);
  for (const z of AXLES_Z) for (const sx of [-1, 1]) fender(ARCH_R + 0.03, 0.14, black, sx * 0.9, -0.12, z); // bolt-on flares

  // Fastback cabin: raked windscreen, flat roof, long sloping rear.
  const cabin = [[0.85, 0.12], [0.05, 0.58], [-0.7, 0.58], [-1.95, 0.12]];
  profile(cabin, 1.42, bodyMat);
  const pane = (w, len, x, y, z, rx) => {
    const mesh = box(w, 0.02, len, glass, x, y, z);
    mesh.rotation.x = rx;
    return mesh;
  };
  pane(1.3, 0.86, 0, 0.36, 0.45, Math.atan2(0.46, 0.8)); // windscreen
  pane(1.2, 0.62, 0, 0.49, -1.0, -Math.atan2(0.46, 1.25)); // rear window
  for (const sx of [-1, 1]) profile([[0.66, 0.17], [0.06, 0.52], [-0.7, 0.52], [-0.95, 0.17]], 0.02, glass, sx * 0.715);
  box(1.44, 0.05, 0.3, black, 0, 0.62, -0.62).rotation.x = -0.15; // roof spoiler
  box(1.7, 0.05, 0.22, black, 0, 0.27, BACK + 0.12); // boot spoiler
  for (const sx of [-1, 1]) box(0.05, 0.14, 0.12, black, sx * 0.6, 0.18, BACK + 0.12);

  // Concorde nose: blacked grille, quad lamps, deep air dam.
  box(1.2, 0.16, 0.04, black, 0, -0.02, FRONT + 0.01);
  for (const sx of [-1, 1]) {
    for (const x of [0.45, 0.72]) tube(0.075, 0.04, head, sx * x, -0.02, FRONT + 0.02);
    box(0.5, 0.08, 0.04, tail, sx * 0.6, -0.04, BACK - 0.01);
  }
  box(WIDTH - 0.1, 0.14, 0.25, black, 0, -0.52, FRONT - 0.05);
  box(WIDTH, 0.1, 0.08, black, 0, -0.18, FRONT + 0.02); // bumper
  box(WIDTH, 0.1, 0.08, black, 0, -0.18, BACK - 0.02);

  // Supercharger through the bonnet: belt, blower case, scoop.
  box(0.3, 0.1, 0.5, black, 0, 0.14, 1.45);
  box(0.38, 0.22, 0.55, chrome, 0, 0.3, 1.45);
  box(0.28, 0.06, 0.04, black, 0, 0.28, 1.74); // belt
  box(0.32, 0.16, 0.38, black, 0, 0.49, 1.48);
  box(0.28, 0.1, 0.04, chrome, 0, 0.5, 1.68); // butterflies

  // Twin fuel tanks in the open boot, zoomie side pipes behind the front wheels.
  for (const sx of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.2, 0.2, 0.62, 14).rotateZ(Math.PI / 2), rust, sx * 0.38, 0.3, BACK + 0.38);
    for (let i = 0; i < 4; i++) {
      const pipe = tube(0.035, 0.5, chrome, sx * 0.97, -0.38 + i * 0.05, 0.85 - i * 0.04, 8);
      pipe.rotation.y = sx * 0.35;
    }
  }

  return { group, bodyMat };
}
