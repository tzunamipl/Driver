import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { createKit, sideOutline } from './kit.js';

// Super: compact mid-engined supercar, low-poly: wedge nose, cab-forward
// bubble, louvred engine deck, side intakes, fixed wing, diffuser.
// Chassis-local, +z forward, 4.3 m long; ground near y = -0.66.
// Axle positions must match ../super.js.

export const AXLES_Z = [1.35, -1.3];
const FRONT_ARCH = { y: -0.33, r: 0.36 };
const REAR_ARCH = { y: -0.33, r: 0.38 };
const FRONT = 2.15;
const BACK = -2.15;
const WIDTH = 1.96;
const CABIN_W = 1.4;

export function buildBody(_chassisWidth, _chassisLength, color = 0xe8b400) {
  const group = new THREE.Group();
  const bodyMat = createPaintMaterial(color, { metalness: 0.4, roughness: 0.25 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 0.7 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x1c1d20, metalness: 0.5, roughness: 0.35 });
  const glass = createGlossyMaterial({ color: 0x0c1116, metalness: 0.5, roughness: 0.08 });
  const head = createGlossyMaterial({ color: 0xeef4ff, emissive: 0x2c3448, roughness: 0.15, userData: { lamp: 'head' } });
  const tail = createGlossyMaterial({ color: 0xc0101c, emissive: 0x400000, roughness: 0.2, userData: { lamp: 'tail' } });
  const pipe = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, metalness: 0.9, roughness: 0.3 });
  const { box, tube, profile } = createKit(group);

  // Long low nose, deck rising over the engine to a high square tail.
  const top = [[FRONT, -0.3], [FRONT + 0.02, -0.14], [FRONT - 0.15, -0.04], [1.05, 0.1], [-0.6, 0.14], [BACK + 0.12, 0.22], [BACK, 0.18], [BACK + 0.02, -0.3]];
  const arches = [{ z: AXLES_Z[0], ...FRONT_ARCH }, { z: AXLES_Z[1], ...REAR_ARCH }];
  profile(sideOutline(top, -0.47, arches), WIDTH, bodyMat);
  box(WIDTH - 0.6, 0.2, FRONT - BACK - 0.3, black, 0, -0.38, 0);

  // Cab-forward bubble running back into the engine cover.
  const cabin = [[1.05, 0.1], [0.15, 0.48], [-0.45, 0.48], [-1.95, 0.22], [-1.95, 0.12]];
  profile(cabin, CABIN_W, bodyMat);
  const ws = box(CABIN_W - 0.1, 0.02, 0.98, glass, 0, 0.3, 0.6);
  ws.rotation.x = Math.atan2(0.38, 0.9);
  const deckY = (z) => 0.48 + ((z + 0.45) * 0.26) / 1.5;
  for (let i = 0; i < 6; i++) {
    const z = -0.8 - i * 0.18;
    box(CABIN_W - 0.3, 0.02, 0.08, black, 0, deckY(z) + 0.012, z).rotation.x = -Math.atan2(0.26, 1.5); // engine louvres
  }
  for (const sx of [-1, 1]) {
    const x = sx * (CABIN_W / 2 + 0.005);
    profile([[0.92, 0.17], [0.15, 0.45], [-0.45, 0.45], [-0.7, 0.17]], 0.02, glass, x);
    box(0.08, 0.06, 0.12, bodyMat, sx * (CABIN_W / 2 + 0.06), 0.24, 0.85); // mirror

    // Side intake ahead of the rear arch, swept headlamps, slim taillights.
    box(0.06, 0.24, 0.5, black, sx * (WIDTH / 2 + 0.005), -0.08, -0.55);
    const lamp = box(0.42, 0.05, 0.12, head, sx * 0.6, -0.05, FRONT - 0.12);
    lamp.rotation.set(0.35, sx * -0.2, 0);
    box(0.6, 0.06, 0.03, tail, sx * 0.6, 0.12, BACK - 0.01);
    box(0.4, 0.12, 0.04, black, sx * 0.62, -0.18, FRONT + 0.0); // corner intake
    box(0.05, 0.22, 0.4, carbon, sx * 0.72, 0.36, BACK + 0.25); // wing end plate
  }
  box(0.7, 0.1, 0.04, black, 0, -0.2, FRONT + 0.0); // centre intake
  box(WIDTH - 0.1, 0.03, 0.2, carbon, 0, -0.33, FRONT - 0.05); // splitter
  box(1.5, 0.03, 0.3, carbon, 0, 0.47, BACK + 0.25).rotation.x = -0.08; // wing
  box(1.3, 0.22, 0.04, black, 0, 0.0, BACK - 0.01); // rear grille
  box(1.6, 0.14, 0.3, carbon, 0, -0.34, BACK + 0.1); // diffuser
  for (const x of [-0.12, 0.12]) tube(0.05, 0.12, pipe, x, -0.16, BACK - 0.04, 10).userData.exhaust = true;

  return { group, bodyMat };
}
