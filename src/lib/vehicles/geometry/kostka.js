import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { createKit, sideOutline } from './kit.js';

// Kostka: early-80s three-door hatchback, all straight lines, low-poly:
// slight wedge bonnet, upright screen, flat roof, steep hatch, square lamps
// in a black grille band, black plastic bumpers. Chassis-local, +z forward,
// 3.7 m long; ground near y = -0.65. Axle positions must match ../kostka.js.

export const AXLES_Z = [1.2, -1.18];
const ARCH = { y: -0.36, r: 0.32 };
const FRONT = 1.85;
const BACK = -1.88;
const WIDTH = 1.6;
const CABIN_W = 1.44;

export function buildBody(_chassisWidth, _chassisLength, color = 0xd94a1a) {
  const group = new THREE.Group();
  const bodyMat = createPaintMaterial(color, { metalness: 0.1, roughness: 0.5 });
  const black = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.85 });
  const grey = new THREE.MeshStandardMaterial({ color: 0x3a3c3e, roughness: 0.7 });
  const glass = createGlossyMaterial({ color: 0x12181d, metalness: 0.5, roughness: 0.12 });
  const head = createGlossyMaterial({ color: 0xf4f2e8, emissive: 0x403418, roughness: 0.2, userData: { lamp: 'head' } });
  const tail = createGlossyMaterial({ color: 0xa8121a, emissive: 0x2a0000, roughness: 0.25, userData: { lamp: 'tail' } });
  const amber = new THREE.MeshStandardMaterial({ color: 0xe08a1a, emissive: 0x3a1c00, roughness: 0.4 });
  const plate = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });
  const { box, tube, profile } = createKit(group);

  const top = [[FRONT, -0.3], [FRONT, 0.08], [FRONT - 0.04, 0.12], [0.7, 0.2], [BACK, 0.24], [BACK, -0.3]];
  const arches = AXLES_Z.map((z) => ({ z, ...ARCH }));
  profile(sideOutline(top, -0.48, arches), WIDTH, bodyMat);
  box(WIDTH - 0.5, 0.22, FRONT - BACK - 0.3, black, 0, -0.4, 0);

  const cabin = [[0.7, 0.2], [0.15, 0.66], [-1.45, 0.67], [BACK + 0.04, 0.24]];
  profile(cabin, CABIN_W, bodyMat);
  const pane = (w, a, b) => {
    const len = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const mesh = box(w, 0.02, len, glass, 0, (a[1] + b[1]) / 2 + 0.01, (a[0] + b[0]) / 2);
    mesh.rotation.x = Math.atan2(b[1] - a[1], a[0] - b[0]);
    return mesh;
  };
  pane(CABIN_W - 0.1, cabin[0], cabin[1]);
  pane(CABIN_W - 0.16, [-1.8, 0.33], [-1.5, 0.63]);
  for (const sx of [-1, 1]) {
    const x = sx * (CABIN_W / 2 + 0.005);
    // Long door glass, then a thick C-pillar around the small rear quarter.
    profile([[0.6, 0.27], [0.15, 0.62], [-0.6, 0.63], [-0.6, 0.27]], 0.02, glass, x);
    profile([[-0.72, 0.27], [-0.72, 0.63], [-1.3, 0.63], [-1.5, 0.27]], 0.02, glass, x);
    box(0.07, 0.08, 0.12, black, sx * (CABIN_W / 2 + 0.05), 0.28, 0.58); // mirror
    box(0.03, 0.08, FRONT - BACK - 0.9, black, sx * (WIDTH / 2 + 0.01), -0.12, -0.02); // rubbing strip

    // Square headlamps with corner indicators, square tail lamps.
    box(0.3, 0.16, 0.03, head, sx * 0.52, 0.0, FRONT + 0.02);
    box(0.08, 0.16, 0.03, amber, sx * 0.73, 0.0, FRONT + 0.02);
    box(0.3, 0.17, 0.03, tail, sx * 0.6, 0.06, BACK - 0.015);
  }
  box(0.74, 0.16, 0.03, black, 0, 0.0, FRONT + 0.015); // grille band
  for (const y of [-0.04, 0.0, 0.04]) box(0.74, 0.012, 0.035, grey, 0, y, FRONT + 0.02);
  box(WIDTH + 0.04, 0.14, 0.1, black, 0, -0.22, FRONT + 0.04);
  box(WIDTH + 0.04, 0.14, 0.1, black, 0, -0.22, BACK - 0.04);
  box(0.46, 0.1, 0.012, plate, 0, -0.22, FRONT + 0.095);
  box(0.46, 0.1, 0.012, plate, 0, 0.06, BACK - 0.02);
  box(0.03, 0.02, 0.32, black, 0.1, 0.48, -1.66).rotation.x = Math.atan2(0.3, 0.3); // rear wiper
  tube(0.03, 0.1, grey, 0.45, -0.42, BACK - 0.02, 10).userData.exhaust = true; // tailpipe

  return { group, bodyMat };
}
