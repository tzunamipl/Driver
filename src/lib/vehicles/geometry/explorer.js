import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { createKit, sideOutline } from './kit.js';

// Explorer: boxy short-overhang 4x4, low-poly: upright glasshouse, flared
// arches, bull bar, snorkel, roof rack and a spare on the tailgate.
// Chassis-local, +z forward, 4.4 m long; ground near y = -0.8.
// Axle positions must match ../explorer.js.

export const AXLES_Z = [1.4, -1.35];
const ARCH = { y: -0.38, r: 0.48 };
const FRONT = 2.1;
const BACK = -2.05;
const WIDTH = 1.84;
const CABIN_W = 1.72;

export function buildBody(_chassisWidth, _chassisLength, color = 0x5a6248) {
  const group = new THREE.Group();
  const bodyMat = createPaintMaterial(color, { metalness: 0.2, roughness: 0.6 });
  const black = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x3a3c3e, metalness: 0.7, roughness: 0.45 });
  const glass = createGlossyMaterial({ color: 0x11171c, metalness: 0.5, roughness: 0.12 });
  const head = createGlossyMaterial({ color: 0xf4f2e8, emissive: 0x403418, roughness: 0.2, userData: { lamp: 'head' } });
  const tail = createGlossyMaterial({ color: 0xa8121a, emissive: 0x2a0000, roughness: 0.25, userData: { lamp: 'tail' } });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95 });
  const { add, box, tube, fender, profile } = createKit(group);

  // Flat bonnet, near-vertical nose and tail; high floor for clearance.
  const top = [[FRONT, -0.3], [FRONT, 0.22], [FRONT - 0.1, 0.3], [0.85, 0.34], [BACK + 0.02, 0.36], [BACK, -0.3]];
  const arches = AXLES_Z.map((z) => ({ z, ...ARCH }));
  profile(sideOutline(top, -0.36, arches), WIDTH, bodyMat);
  box(WIDTH - 0.6, 0.2, FRONT - BACK - 0.4, black, 0, -0.3, 0);
  for (const z of AXLES_Z) for (const sx of [-1, 1]) fender(ARCH.r + 0.04, 0.12, black, sx * (WIDTH / 2 + 0.02), ARCH.y + 0.02, z);

  // Upright box cabin, short windscreen rake, vertical tailgate glass.
  const cabin = [[0.85, 0.34], [0.55, 0.98], [BACK + 0.04, 1.0], [BACK + 0.02, 0.36]];
  profile(cabin, CABIN_W, bodyMat);
  const ws = box(CABIN_W - 0.12, 0.02, 0.68, glass, 0, 0.67, 0.71);
  ws.rotation.x = Math.atan2(0.64, 0.3);
  box(CABIN_W - 0.24, 0.5, 0.02, glass, 0, 0.7, BACK + 0.01);
  for (const sx of [-1, 1]) {
    const x = sx * (CABIN_W / 2 + 0.005);
    profile([[0.72, 0.44], [0.53, 0.9], [0.0, 0.9], [0.0, 0.44]], 0.02, glass, x);
    profile([[-0.12, 0.44], [-0.12, 0.9], [-1.0, 0.9], [-1.0, 0.44]], 0.02, glass, x);
    profile([[-1.12, 0.44], [-1.12, 0.9], [-1.9, 0.9], [-1.9, 0.44]], 0.02, glass, x);
    box(0.1, 0.12, 0.16, black, sx * (CABIN_W / 2 + 0.07), 0.48, 0.72); // mirror
    box(0.03, 0.1, 3.6, black, sx * (WIDTH / 2 + 0.01), -0.28, 0); // rock slider

    // Round headlamps in a black grille panel, small upright taillights.
    tube(0.1, 0.04, head, sx * 0.62, 0.1, FRONT + 0.02);
    box(0.12, 0.26, 0.03, tail, sx * 0.8, 0.12, BACK - 0.01);
  }
  box(1.5, 0.3, 0.03, black, 0, 0.1, FRONT + 0.005);
  for (let i = -2; i <= 2; i++) box(0.05, 0.22, 0.035, steel, i * 0.12, 0.1, FRONT + 0.015);

  // Bull bar, steel bumpers, rear spare wheel.
  box(WIDTH + 0.04, 0.16, 0.14, steel, 0, -0.2, FRONT + 0.08);
  for (const sx of [-1, 1]) {
    box(0.06, 0.5, 0.06, steel, sx * 0.55, 0.12, FRONT + 0.14);
    box(0.06, 0.06, 0.2, steel, sx * 0.55, 0.36, FRONT + 0.06);
  }
  box(1.16, 0.06, 0.06, steel, 0, 0.38, FRONT + 0.14);
  box(WIDTH + 0.04, 0.16, 0.12, steel, 0, -0.2, BACK - 0.06);
  tube(0.38, 0.25, tyre, 0, 0.5, BACK - 0.16, 18);
  tube(0.22, 0.26, steel, 0, 0.5, BACK - 0.16, 10);

  // Snorkel up the right A-pillar, roof rack.
  box(0.1, 0.4, 0.1, black, -(WIDTH / 2 + 0.02), 0.15, 0.95);
  box(0.09, 0.66, 0.09, black, -(CABIN_W / 2 + 0.05), 0.68, 0.7).rotation.x = -0.4;
  add(new THREE.BoxGeometry(0.14, 0.1, 0.18), black, -(CABIN_W / 2 + 0.05), 1.04, 0.6);
  for (const sx of [-1, 1]) box(0.04, 0.04, 2.3, steel, sx * 0.72, 1.1, -0.6);
  for (const z of [0.4, -0.4, -1.2, -1.7]) box(1.48, 0.03, 0.04, steel, 0, 1.1, z);
  for (const sx of [-1, 1]) for (const z of [0.4, -1.7]) box(0.04, 0.1, 0.04, steel, sx * 0.72, 1.04, z);

  return { group, bodyMat };
}
