import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { createKit, sideOutline } from './kit.js';

// Malaise: late-70s compact two-door saloon, low-poly: slab sides, flat
// bonnet and boot, formal notchback roof with a landau vinyl top and opera
// windows, quad square lamps, huge impact bumpers. Chassis-local, +z forward,
// 4.5 m long; ground near y = -0.77. Axle positions must match ../malaise.js.

export const AXLES_Z = [1.33, -1.33];
const ARCH = { y: -0.4, r: 0.38 };
const FRONT = 2.25;
const BACK = -2.25;
const WIDTH = 1.78;
const CABIN_W = 1.5;

export function buildBody(_chassisWidth, _chassisLength, color = 0x6e4a26) {
  const group = new THREE.Group();
  const bodyMat = createPaintMaterial(color, { metalness: 0.3, roughness: 0.4 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0e0e0e, roughness: 0.85 });
  const vinyl = new THREE.MeshStandardMaterial({ color: 0xd9cfb0, roughness: 0.9 });
  const chrome = createGlossyMaterial({ color: 0xdadde2, metalness: 1, roughness: 0.14 });
  const glass = createGlossyMaterial({ color: 0x10161b, metalness: 0.5, roughness: 0.1 });
  const head = createGlossyMaterial({ color: 0xfff4d8, emissive: 0x554417, roughness: 0.25, userData: { lamp: 'head' } });
  const tail = createGlossyMaterial({ color: 0xb0101a, emissive: 0x400000, roughness: 0.3, userData: { lamp: 'tail' } });
  const amber = new THREE.MeshStandardMaterial({ color: 0xe08a1a, emissive: 0x3a1c00, roughness: 0.4 });
  const plate = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });
  const { box, tube, profile } = createKit(group);

  // Dead-flat bonnet and boot deck, square nose and tail.
  const top = [[FRONT, -0.32], [FRONT, 0.12], [FRONT - 0.04, 0.16], [0.85, 0.18], [-1.4, 0.2], [BACK + 0.04, 0.2], [BACK, 0.14], [BACK, -0.32]];
  const arches = AXLES_Z.map((z) => ({ z, ...ARCH }));
  profile(sideOutline(top, -0.52, arches), WIDTH, bodyMat);
  box(WIDTH - 0.5, 0.26, FRONT - BACK - 0.3, black, 0, -0.44, 0);

  // Formal roof: upright rear glass, vinyl over the back two thirds.
  const cabin = [[0.85, 0.18], [0.35, 0.64], [-0.85, 0.65], [-1.4, 0.2]];
  profile(cabin, CABIN_W, bodyMat);
  const pane = (w, a, b) => {
    const len = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const mesh = box(w, 0.02, len, glass, 0, (a[1] + b[1]) / 2 + 0.01, (a[0] + b[0]) / 2);
    mesh.rotation.x = Math.atan2(b[1] - a[1], a[0] - b[0]);
    return mesh;
  };
  pane(CABIN_W - 0.12, cabin[0], cabin[1]);
  pane(CABIN_W - 0.16, cabin[3], cabin[2]);
  box(CABIN_W - 0.06, 0.025, 0.85, vinyl, 0, 0.66, -0.42);

  for (const sx of [-1, 1]) {
    const x = sx * (CABIN_W / 2 + 0.005);
    // Long door glass, small opera window in the vinyl-covered C-pillar.
    profile([[0.74, 0.26], [0.34, 0.6], [-0.45, 0.61], [-0.45, 0.26]], 0.02, glass, x);
    profile([[-0.62, 0.36], [-0.62, 0.55], [-0.9, 0.55], [-0.9, 0.36]], 0.02, glass, sx * (CABIN_W / 2 + 0.012));
    profile([[-0.55, 0.3], [-0.55, 0.64], [-0.86, 0.64], [-1.36, 0.22], [-1.0, 0.22], [-1.0, 0.3]], 0.01, vinyl, sx * (CABIN_W / 2 + 0.002));
    box(0.08, 0.08, 0.12, chrome, sx * (CABIN_W / 2 + 0.05), 0.3, 0.72); // mirror
    box(0.02, 0.03, FRONT - BACK - 0.3, chrome, sx * (WIDTH / 2 + 0.005), -0.28, 0); // rocker trim
    box(0.02, 0.02, 2.0, chrome, sx * (CABIN_W / 2 + 0.01), 0.25, -0.3); // belt chrome
    box(0.02, 0.05, 0.12, amber, sx * (WIDTH / 2 + 0.005), 0.0, FRONT - 0.2); // side markers
    box(0.02, 0.05, 0.12, tail, sx * (WIDTH / 2 + 0.005), 0.0, BACK + 0.2);

    // Quad square headlamps flanking the grille; wide taillight blocks.
    for (const lx of [0.5, 0.7]) box(0.18, 0.12, 0.03, head, sx * lx, 0.05, FRONT + 0.015);
    box(0.52, 0.14, 0.03, tail, sx * 0.56, 0.05, BACK - 0.015);
    box(0.16, 0.06, 0.031, amber, sx * 0.56, -0.06, BACK - 0.015);
    box(0.08, 0.22, 0.06, black, sx * 0.42, -0.22, FRONT + 0.22); // bumper guards
    box(0.08, 0.22, 0.06, black, sx * 0.42, -0.22, BACK - 0.22);
  }
  box(0.74, 0.17, 0.03, black, 0, 0.04, FRONT + 0.015); // egg-crate grille
  for (const y of [-0.01, 0.04, 0.09]) box(0.74, 0.012, 0.035, chrome, 0, y, FRONT + 0.02);
  box(0.78, 0.02, 0.04, chrome, 0, 0.13, FRONT + 0.02);

  // Park-bench impact bumpers with rubber strips.
  for (const [z, s] of [[FRONT, 1], [BACK, -1]]) {
    box(WIDTH + 0.06, 0.16, 0.2, chrome, 0, -0.22, z + s * 0.1);
    box(WIDTH + 0.08, 0.045, 0.205, black, 0, -0.22, z + s * 0.1);
  }
  box(0.52, 0.11, 0.012, plate, 0, -0.22, FRONT + 0.21);
  box(0.52, 0.11, 0.012, plate, 0, 0.05, BACK - 0.02);
  tube(0.04, 0.14, chrome, -0.55, -0.46, BACK - 0.05, 10);

  return { group, bodyMat };
}
