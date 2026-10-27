import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { createKit, sideOutline } from './kit.js';

// Urban: kei-class one-box family van, low-poly: stub nose, cab-over front
// axle, tall flat-sided glasshouse with a sliding door, upright tailgate,
// roof rails, yellow plates. Chassis-local, +z forward, 3.4 m long; ground
// near y = -0.67. Axle positions must match ../urban.js.

export const AXLES_Z = [1.12, -1.15];
const ARCH = { y: -0.4, r: 0.31 };
const FRONT = 1.7;
const BACK = -1.7;
const WIDTH = 1.47;
const CABIN_W = 1.43;

export function buildBody(_chassisWidth, _chassisLength, color = 0xe8ecef) {
  const group = new THREE.Group();
  const bodyMat = createPaintMaterial(color, { metalness: 0.1, roughness: 0.5 });
  const black = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.6, roughness: 0.5 });
  const glass = createGlossyMaterial({ color: 0x12181d, metalness: 0.5, roughness: 0.12 });
  const head = createGlossyMaterial({ color: 0xf4f2e8, emissive: 0x403418, roughness: 0.2, userData: { lamp: 'head' } });
  const tail = createGlossyMaterial({ color: 0xa8121a, emissive: 0x2a0000, roughness: 0.25, userData: { lamp: 'tail' } });
  const amber = new THREE.MeshStandardMaterial({ color: 0xe08a1a, emissive: 0x3a1c00, roughness: 0.4 });
  const plate = new THREE.MeshStandardMaterial({ color: 0xf2d22a, roughness: 0.6 });
  const { box, tube, profile } = createKit(group);

  const top = [[FRONT, -0.35], [FRONT + 0.02, 0.12], [FRONT - 0.05, 0.22], [1.5, 0.28], [BACK, 0.3], [BACK, -0.35]];
  const arches = AXLES_Z.map((z) => ({ z, ...ARCH }));
  profile(sideOutline(top, -0.5, arches), WIDTH, bodyMat);
  box(WIDTH - 0.5, 0.2, FRONT - BACK - 0.3, black, 0, -0.42, 0);

  // One box: short raked screen, flat roof all the way back, flat tailgate.
  const cabin = [[1.5, 0.28], [1.2, 1.1], [1.08, 1.15], [BACK + 0.02, 1.15], [BACK, 0.3]];
  profile(cabin, CABIN_W, bodyMat);
  const ws = box(CABIN_W - 0.1, 0.02, Math.hypot(0.3, 0.82), glass, 0, 0.7, 1.36);
  ws.rotation.x = Math.atan2(0.82, 0.3);
  box(CABIN_W - 0.3, 0.45, 0.02, glass, 0, 0.82, BACK - 0.005);
  for (const sx of [-1, 1]) {
    const x = sx * (CABIN_W / 2 + 0.005);
    profile([[1.42, 0.52], [1.23, 1.02], [0.65, 1.02], [0.65, 0.52]], 0.02, glass, x);
    profile([[0.5, 0.52], [0.5, 1.02], [-0.55, 1.02], [-0.55, 0.52]], 0.02, glass, x);
    profile([[-0.7, 0.52], [-0.7, 1.02], [-1.55, 1.02], [-1.55, 0.52]], 0.02, glass, x);
    box(0.02, 0.03, 1.0, black, sx * (CABIN_W / 2 + 0.012), 0.47, -1.05); // sliding-door rail
    box(0.06, 0.14, 0.08, black, sx * (CABIN_W / 2 + 0.08), 0.62, 1.42); // mirror
    box(0.03, 0.1, FRONT - BACK - 0.9, black, sx * (WIDTH / 2 + 0.01), -0.18, -0.05); // rubbing strip
    box(0.04, 0.04, 2.3, black, sx * 0.6, 1.18, -0.45); // roof rails
    for (const z of [0.6, -1.55]) box(0.04, 0.04, 0.04, black, sx * 0.6, 1.16, z);

    // Upright square headlamps at the nose corners, tall tail lamps.
    box(0.26, 0.18, 0.03, head, sx * 0.5, 0.02, FRONT + 0.03);
    box(0.08, 0.1, 0.03, amber, sx * 0.68, 0.02, FRONT + 0.025);
    box(0.12, 0.36, 0.03, tail, sx * 0.64, 0.5, BACK - 0.015);
  }
  box(0.6, 0.08, 0.03, black, 0, 0.0, FRONT + 0.03); // slot grille
  box(WIDTH + 0.02, 0.18, 0.1, black, 0, -0.3, FRONT + 0.04);
  box(WIDTH + 0.02, 0.18, 0.1, black, 0, -0.3, BACK - 0.04);
  box(0.4, 0.1, 0.012, plate, 0, -0.3, FRONT + 0.095);
  box(0.4, 0.1, 0.012, plate, 0, -0.05, BACK - 0.02);
  tube(0.03, 0.1, steel, 0.45, -0.45, BACK - 0.02, 10).userData.exhaust = true; // tailpipe

  return { group, bodyMat };
}
