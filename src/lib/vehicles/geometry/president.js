import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { createKit, sideOutline } from './kit.js';

// President SX: long three-box luxury saloon, low-poly. Chassis-local, origin
// near the centre of mass, +z forward, 5.2 m long; ground near y = -0.73.
// Axle positions must match ../president.js.

export const AXLES_Z = [1.55, -1.55];
const ARCH = { y: -0.38, r: 0.42 };
const FRONT = 2.6;
const BACK = -2.6;
const WIDTH = 1.9;
const CABIN_W = 1.62;

export function buildBody(_chassisWidth, _chassisLength, color = 0x15181f) {
  const group = new THREE.Group();
  const bodyMat = createPaintMaterial(color, { metalness: 0.5, roughness: 0.3 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.8 });
  const chrome = createGlossyMaterial({ color: 0xdadde2, metalness: 1, roughness: 0.12 });
  const glass = createGlossyMaterial({ color: 0x0e1418, metalness: 0.5, roughness: 0.1 });
  const head = createGlossyMaterial({ color: 0xf6f8fa, emissive: 0x403418, roughness: 0.15, userData: { lamp: 'head' } });
  const tail = createGlossyMaterial({ color: 0xa4101a, emissive: 0x2a0000, roughness: 0.25, userData: { lamp: 'tail' } });
  const plate = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });
  const { add, box, tube, profile } = createKit(group);

  // Long bonnet, upright cabin, flat boot deck.
  const top = [[FRONT, -0.32], [FRONT + 0.03, 0.04], [FRONT - 0.08, 0.13], [0.95, 0.2], [-1.6, 0.23], [BACK + 0.06, 0.21], [BACK, 0.05], [BACK + 0.02, -0.32]];
  const arches = AXLES_Z.map((z) => ({ z, ...ARCH }));
  profile(sideOutline(top, -0.52, arches), WIDTH, bodyMat);
  box(WIDTH - 0.5, 0.3, FRONT - BACK - 0.3, black, 0, -0.4, 0); // tub behind the arches

  const cabin = [[0.95, 0.2], [0.2, 0.68], [-0.85, 0.7], [-1.6, 0.23]];
  profile(cabin, CABIN_W, bodyMat);
  const pane = (w, a, b, inset = 0.01) => {
    const len = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const mesh = box(w, 0.02, len, glass, 0, (a[1] + b[1]) / 2 + inset, (a[0] + b[0]) / 2);
    mesh.rotation.x = Math.atan2(b[1] - a[1], a[0] - b[0]);
    return mesh;
  };
  pane(CABIN_W - 0.12, cabin[0], cabin[1]); // windscreen
  pane(CABIN_W - 0.16, cabin[3], cabin[2]); // rear window
  for (const sx of [-1, 1]) {
    // Two side windows split by a body-colour B-pillar, chrome line under them.
    profile([[0.82, 0.27], [0.22, 0.63], [-0.28, 0.64], [-0.28, 0.27]], 0.02, glass, sx * (CABIN_W / 2 + 0.005));
    profile([[-0.4, 0.27], [-0.4, 0.64], [-0.85, 0.65], [-1.42, 0.27]], 0.02, glass, sx * (CABIN_W / 2 + 0.005));
    box(0.02, 0.02, 2.3, chrome, sx * (CABIN_W / 2 + 0.01), 0.25, -0.3);
    box(0.02, 0.025, FRONT - BACK - 0.6, chrome, sx * (WIDTH / 2 + 0.005), -0.12, 0); // waist strip
    box(0.08, 0.09, 0.15, bodyMat, sx * (CABIN_W / 2 + 0.06), 0.33, 0.78); // mirror

    // Rectangular twin headlamps either side of the grille; long taillights.
    box(0.42, 0.13, 0.03, head, sx * 0.6, 0.03, FRONT + 0.03);
    box(0.5, 0.12, 0.03, tail, sx * 0.62, 0.08, BACK - 0.01);
    box(0.25, 0.06, 0.031, chrome, sx * 0.62, -0.03, BACK - 0.01); // reverse-lamp trim
    tube(0.04, 0.12, chrome, sx * 0.55, -0.42, BACK - 0.04, 10); // twin tailpipes
  }

  // Tall chrome grille with vertical slats and the bonnet ornament.
  box(0.5, 0.24, 0.03, black, 0, 0.0, FRONT + 0.035);
  for (let i = -3; i <= 3; i++) box(0.02, 0.24, 0.035, chrome, i * 0.07, 0.0, FRONT + 0.04);
  box(0.54, 0.03, 0.04, chrome, 0, 0.13, FRONT + 0.03);
  const ornament = add(new THREE.ConeGeometry(0.03, 0.12, 4), chrome, 0, 0.21, FRONT - 0.1);
  ornament.rotation.x = -0.4;

  // Chrome bumpers and plates.
  box(WIDTH + 0.02, 0.09, 0.08, chrome, 0, -0.2, FRONT + 0.04);
  box(WIDTH + 0.02, 0.09, 0.08, chrome, 0, -0.18, BACK - 0.03);
  box(0.52, 0.11, 0.012, plate, 0, -0.32, FRONT + 0.05);
  box(0.52, 0.11, 0.012, plate, 0, -0.05, BACK - 0.02);

  return { group, bodyMat };
}
