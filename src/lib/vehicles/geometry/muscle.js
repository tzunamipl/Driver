import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { createKit, sideOutline } from './kit.js';

// Muscle: late-60s big-block hardtop, low-poly: long bonnet with a power
// bulge and scoop, short boot with a ducktail, full-width grille with quad
// lamps, chrome bumpers, twin stripes. Chassis-local, +z forward, 5.0 m
// long; ground near y = -0.74. Axle positions must match ../muscle.js.

export const AXLES_Z = [1.45, -1.45];
const ARCH = { y: -0.38, r: 0.42 };
const FRONT = 2.5;
const BACK = -2.5;
const WIDTH = 1.9;
const CABIN_W = 1.6;

export function buildBody(_chassisWidth, _chassisLength, color = 0x8a1414) {
  const group = new THREE.Group();
  const bodyMat = createPaintMaterial(color, { metalness: 0.25, roughness: 0.35 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.8 });
  const stripe = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.5 });
  const chrome = createGlossyMaterial({ color: 0xdadde2, metalness: 1, roughness: 0.12 });
  const glass = createGlossyMaterial({ color: 0x10161b, metalness: 0.5, roughness: 0.1 });
  const head = createGlossyMaterial({ color: 0xfff4d8, emissive: 0x554417, roughness: 0.25, userData: { lamp: 'head' } });
  const tail = createGlossyMaterial({ color: 0xb0101a, emissive: 0x400000, roughness: 0.3, userData: { lamp: 'tail' } });
  const plate = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });
  const { box, tube, profile } = createKit(group);

  const top = [[FRONT, -0.3], [FRONT + 0.02, 0.1], [FRONT - 0.06, 0.16], [0.9, 0.2], [-1.6, 0.21], [BACK + 0.06, 0.21], [BACK, 0.08], [BACK, -0.3]];
  const arches = AXLES_Z.map((z) => ({ z, ...ARCH }));
  profile(sideOutline(top, -0.5, arches), WIDTH, bodyMat);
  box(WIDTH - 0.5, 0.26, FRONT - BACK - 0.3, black, 0, -0.42, 0);

  // Hardtop: raked screen, flat roof, long sail panels to the boot.
  const cabin = [[0.9, 0.2], [0.25, 0.6], [-0.8, 0.61], [-1.65, 0.21]];
  profile(cabin, CABIN_W, bodyMat);
  const pane = (w, a, b) => {
    const len = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const mesh = box(w, 0.02, len, glass, 0, (a[1] + b[1]) / 2 + 0.01, (a[0] + b[0]) / 2);
    mesh.rotation.x = Math.atan2(b[1] - a[1], a[0] - b[0]);
    return mesh;
  };
  pane(CABIN_W - 0.12, cabin[0], cabin[1]);
  pane(CABIN_W - 0.3, [-1.45, 0.3], cabin[2]);
  box(CABIN_W - 0.1, 0.02, 1.0, black, 0, 0.615, -0.27); // vinyl roof

  // Power bulge and scoop, twin stripes bonnet to boot.
  box(0.7, 0.05, 1.3, bodyMat, 0, 0.22, 1.65);
  box(0.4, 0.1, 0.3, black, 0, 0.29, 1.5);
  for (const sx of [-1, 1]) {
    const x = sx * 0.18;
    box(0.14, 0.012, 1.3, stripe, x, 0.252, 1.65);
    box(0.14, 0.012, 1.0, stripe, x, 0.627, -0.27);
    box(0.14, 0.012, 0.8, stripe, x, 0.218, -2.05);
  }

  for (const sx of [-1, 1]) {
    profile([[0.78, 0.27], [0.25, 0.56], [-0.75, 0.57], [-1.1, 0.27]], 0.02, glass, sx * (CABIN_W / 2 + 0.005));
    box(0.08, 0.08, 0.12, chrome, sx * (CABIN_W / 2 + 0.05), 0.3, 0.75); // mirror
    box(0.02, 0.03, FRONT - BACK - 0.3, chrome, sx * (WIDTH / 2 + 0.005), -0.2, 0); // rocker trim
    box(0.02, 0.025, 2.4, chrome, sx * (CABIN_W / 2 + 0.01), 0.25, -0.15); // belt chrome

    // Quad round headlamps in the grille, wide taillights.
    for (const x of [0.5, 0.75]) tube(0.08, 0.04, head, sx * x, 0.02, FRONT + 0.03);
    box(0.55, 0.1, 0.03, tail, sx * 0.55, 0.02, BACK - 0.01);
    tube(0.045, 0.14, chrome, sx * 0.6, -0.44, BACK - 0.05, 10); // tailpipes
  }
  box(WIDTH - 0.1, 0.22, 0.03, black, 0, 0.02, FRONT + 0.015); // full-width grille
  box(WIDTH + 0.04, 0.1, 0.1, chrome, 0, -0.2, FRONT + 0.05);
  box(WIDTH + 0.04, 0.1, 0.1, chrome, 0, -0.2, BACK - 0.04);
  box(1.4, 0.04, 0.14, bodyMat, 0, 0.24, BACK + 0.08).rotation.x = -0.3; // ducktail
  box(0.52, 0.11, 0.012, plate, 0, -0.08, BACK - 0.02);

  return { group, bodyMat };
}
