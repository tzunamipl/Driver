import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { createKit, sideOutline } from './kit.js';

// Seagul: small, light fastback coupe, low-poly: low flat nose, long glass
// hatch, small boot spoiler, bolt-on arch lips. Chassis-local, +z forward,
// 4.15 m long; ground near y = -0.66. Axle positions must match ../seagul.js.

export const AXLES_Z = [1.2, -1.2];
const ARCH = { y: -0.33, r: 0.35 };
const FRONT = 2.05;
const BACK = -2.1;
const WIDTH = 1.68;
const CABIN_W = 1.42;

export function buildBody(_chassisWidth, _chassisLength, color = 0xf2f0ea) {
  const group = new THREE.Group();
  const bodyMat = createPaintMaterial(color, { metalness: 0.15, roughness: 0.45 });
  const black = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.8 });
  const glass = createGlossyMaterial({ color: 0x10161b, metalness: 0.5, roughness: 0.1 });
  const head = createGlossyMaterial({ color: 0xf4f2e8, emissive: 0x403418, roughness: 0.2, userData: { lamp: 'head' } });
  const fog = createGlossyMaterial({ color: 0xffe8a0, emissive: 0x5a4416, roughness: 0.3, userData: { lamp: 'fog' } });
  const tail = createGlossyMaterial({ color: 0xa8121a, emissive: 0x2a0000, roughness: 0.25, userData: { lamp: 'tail' } });
  const plate = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });
  const { box, tube, fender, profile } = createKit(group);

  const top = [[FRONT, -0.26], [FRONT + 0.02, -0.04], [FRONT - 0.1, 0.05], [0.7, 0.14], [-1.9, 0.2], [BACK, 0.12], [BACK + 0.03, -0.26]];
  const arches = AXLES_Z.map((z) => ({ z, ...ARCH }));
  profile(sideOutline(top, -0.45, arches), WIDTH, bodyMat);
  box(WIDTH - 0.5, 0.24, FRONT - BACK - 0.3, black, 0, -0.34, 0);
  for (const z of AXLES_Z) for (const sx of [-1, 1]) fender(ARCH.r + 0.02, 0.07, black, sx * (WIDTH / 2), ARCH.y, z);

  // Fastback: the roof runs straight into the hatch glass.
  const cabin = [[0.7, 0.14], [0.0, 0.55], [-0.55, 0.56], [-1.9, 0.2]];
  profile(cabin, CABIN_W, bodyMat);
  const pane = (w, a, b) => {
    const len = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const mesh = box(w, 0.02, len, glass, 0, (a[1] + b[1]) / 2 + 0.01, (a[0] + b[0]) / 2);
    mesh.rotation.x = Math.atan2(b[1] - a[1], a[0] - b[0]);
    return mesh;
  };
  pane(CABIN_W - 0.1, cabin[0], cabin[1]);
  pane(CABIN_W - 0.14, [-1.75, 0.25], cabin[2]);
  for (const sx of [-1, 1]) {
    profile([[0.58, 0.2], [0.0, 0.51], [-0.55, 0.52], [-1.2, 0.21]], 0.02, glass, sx * (CABIN_W / 2 + 0.005));
    box(0.07, 0.07, 0.12, black, sx * (CABIN_W / 2 + 0.05), 0.26, 0.55); // mirror

    // Narrow lamps under a flat nose, fog lamps low; full-width tail strip.
    box(0.4, 0.08, 0.03, head, sx * 0.52, 0.0, FRONT + 0.02);
    tube(0.045, 0.04, fog, sx * 0.55, -0.2, FRONT + 0.02, 10);
    box(0.5, 0.1, 0.03, tail, sx * 0.48, 0.03, BACK - 0.01);
  }
  box(0.25, 0.08, 0.03, black, 0, 0.0, FRONT + 0.02); // slot grille
  box(WIDTH - 0.06, 0.08, 0.06, black, 0, -0.32, FRONT + 0.02); // lip spoiler
  box(1.3, 0.035, 0.16, black, 0, 0.18, BACK + 0.08).rotation.x = -0.18; // boot spoiler
  box(WIDTH, 0.08, 0.05, black, 0, -0.18, BACK - 0.01);
  tube(0.04, 0.12, black, 0.5, -0.36, BACK - 0.02, 10);
  box(0.46, 0.1, 0.012, plate, 0, -0.18, FRONT + 0.04);
  box(0.46, 0.1, 0.012, plate, 0, -0.08, BACK - 0.02);

  return { group, bodyMat };
}
