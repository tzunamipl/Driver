import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { createKit, sideOutline } from './kit.js';

// Worker: small leisure van, low-poly: short sloping bonnet, tall box body
// with a bulging front roof, sliding side door, barn-door rear, chunky black
// bumpers and roof bars. Chassis-local, +z forward, 4.0 m long; ground near
// y = -0.75. Axle positions must match ../worker.js and ../majster.js.

export const AXLES_Z = [1.32, -1.28];
const ARCH = { y: -0.42, r: 0.36 };
const FRONT = 1.95;
const BACK = -2.05;
const WIDTH = 1.68;
const CABIN_W = 1.6;

export function buildBody(_chassisWidth, _chassisLength, color = 0x8fb0c4) {
  const group = new THREE.Group();
  const bodyMat = createPaintMaterial(color, { metalness: 0.15, roughness: 0.5 });
  const black = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.6, roughness: 0.5 });
  const glass = createGlossyMaterial({ color: 0x12181d, metalness: 0.5, roughness: 0.12 });
  const head = createGlossyMaterial({ color: 0xf4f2e8, emissive: 0x403418, roughness: 0.2, userData: { lamp: 'head' } });
  const tail = createGlossyMaterial({ color: 0xa8121a, emissive: 0x2a0000, roughness: 0.25, userData: { lamp: 'tail' } });
  const plate = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });
  const { box, tube, fender, profile } = createKit(group);

  const top = [[FRONT, -0.33], [FRONT + 0.03, 0.05], [FRONT - 0.1, 0.2], [1.1, 0.34], [BACK, 0.36], [BACK, -0.33]];
  const arches = AXLES_Z.map((z) => ({ z, ...ARCH }));
  profile(sideOutline(top, -0.52, arches), WIDTH, bodyMat);
  box(WIDTH - 0.5, 0.24, FRONT - BACK - 0.3, black, 0, -0.44, 0);
  for (const z of AXLES_Z) for (const sx of [-1, 1]) fender(ARCH.r + 0.03, 0.06, black, sx * (WIDTH / 2), ARCH.y, z);

  // Tall box with the roof humped over the front seats.
  const cabin = [[1.1, 0.34], [0.55, 1.0], [0.2, 1.08], [-0.4, 1.06], [BACK + 0.03, 1.06], [BACK, 0.36]];
  profile(cabin, CABIN_W, bodyMat);
  const ws = box(CABIN_W - 0.12, 0.02, Math.hypot(0.55, 0.66), glass, 0, 0.68, 0.825);
  ws.rotation.x = Math.atan2(0.66, 0.55);
  for (const sx of [-1, 1]) {
    const x = sx * (CABIN_W / 2 + 0.005);
    profile([[0.98, 0.48], [0.6, 0.93], [0.05, 0.96], [0.05, 0.48]], 0.02, glass, x);
    profile([[-0.08, 0.48], [-0.08, 0.95], [-1.0, 0.95], [-1.0, 0.48]], 0.02, glass, x);
    profile([[-1.12, 0.48], [-1.12, 0.95], [-1.9, 0.95], [-1.9, 0.48]], 0.02, glass, x);
    box(0.02, 0.03, 0.95, black, sx * (CABIN_W / 2 + 0.012), 0.44, -1.55); // sliding-door rail
    box(0.1, 0.16, 0.12, black, sx * (CABIN_W / 2 + 0.08), 0.6, 0.95); // mirror
    box(0.03, 0.12, 2.9, black, sx * (WIDTH / 2 + 0.01), -0.1, -0.05); // rubbing strip
    box(0.04, 0.06, 2.1, black, sx * 0.72, 1.1, -0.75); // roof rails

    // Barn doors: a pane each side of the split.
    box(0.66, 0.4, 0.02, glass, sx * 0.37, 0.78, BACK - 0.005);
    box(0.36, 0.14, 0.06, head, sx * 0.55, 0.08, FRONT);
    box(0.1, 0.42, 0.03, tail, sx * 0.76, 0.52, BACK - 0.015);
  }
  box(0.02, 0.7, 0.02, black, 0, 0.66, BACK - 0.012);
  for (const z of [0.0, -1.5]) box(1.48, 0.04, 0.05, steel, 0, 1.14, z);
  box(0.6, 0.1, 0.04, black, 0, 0.05, FRONT + 0.01); // grille
  box(WIDTH + 0.04, 0.24, 0.12, black, 0, -0.25, FRONT + 0.04);
  box(WIDTH + 0.04, 0.24, 0.12, black, 0, -0.25, BACK - 0.04);
  box(0.52, 0.11, 0.012, plate, 0, -0.25, FRONT + 0.105);
  box(0.52, 0.11, 0.012, plate, 0, 0.2, BACK - 0.02);
  tube(0.035, 0.1, steel, 0.5, -0.45, BACK - 0.03, 10);

  return { group, bodyMat };
}
