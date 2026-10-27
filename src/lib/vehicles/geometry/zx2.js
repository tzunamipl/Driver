import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { createKit, sideOutline } from './kit.js';

// ZX2 compact sport saloon, low-poly: long bonnet, cabin set back, short
// boot with a ducktail lip; one slim bar grille joining the lamps and a wide
// lower intake. Chassis-local, +z forward, 4.6 m long; ground near y = -0.7.
// Axle positions must match ../zx2.js.

export const AXLES_Z = [1.42, -1.38];
const ARCH = { y: -0.36, r: 0.38 };
const FRONT = 2.28;
const BACK = -2.3;
const WIDTH = 1.8;
const CABIN_W = 1.52;

export function buildBody(_chassisWidth, _chassisLength, color = 0xd8dce0) {
  const group = new THREE.Group();
  const bodyMat = createPaintMaterial(color, { metalness: 0.45, roughness: 0.3 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0d0d0d, roughness: 0.75 });
  const satin = new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.6, roughness: 0.4 });
  const glass = createGlossyMaterial({ color: 0x0f151a, metalness: 0.5, roughness: 0.1 });
  const head = createGlossyMaterial({ color: 0xeef4ff, emissive: 0x2c3448, roughness: 0.15, userData: { lamp: 'head' } });
  const tail = createGlossyMaterial({ color: 0x9a0e18, emissive: 0x2a0000, roughness: 0.25, userData: { lamp: 'tail' } });
  const plate = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });
  const { box, tube, profile } = createKit(group);

  // Wedge nose rising to a high, short tail.
  const top = [[FRONT, -0.3], [FRONT + 0.02, -0.02], [FRONT - 0.12, 0.08], [0.75, 0.2], [-1.75, 0.25], [BACK + 0.05, 0.3], [BACK, 0.12], [BACK + 0.04, -0.3]];
  const arches = AXLES_Z.map((z) => ({ z, ...ARCH }));
  profile(sideOutline(top, -0.5, arches), WIDTH, bodyMat);
  box(WIDTH - 0.5, 0.26, FRONT - BACK - 0.3, black, 0, -0.38, 0);

  const cabin = [[0.75, 0.2], [-0.05, 0.62], [-0.95, 0.63], [-1.75, 0.25]];
  profile(cabin, CABIN_W, bodyMat);
  const pane = (w, a, b) => {
    const len = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const mesh = box(w, 0.02, len, glass, 0, (a[1] + b[1]) / 2 + 0.01, (a[0] + b[0]) / 2);
    mesh.rotation.x = Math.atan2(b[1] - a[1], a[0] - b[0]);
    return mesh;
  };
  pane(CABIN_W - 0.1, cabin[0], cabin[1]);
  pane(CABIN_W - 0.14, cabin[3], cabin[2]);
  for (const sx of [-1, 1]) {
    // Glasshouse in one sweep with a black B-pillar and a straight C-pillar.
    profile([[0.62, 0.27], [-0.03, 0.58], [-0.95, 0.59], [-1.45, 0.27]], 0.02, glass, sx * (CABIN_W / 2 + 0.005));
    box(0.025, 0.32, 0.07, black, sx * (CABIN_W / 2 + 0.012), 0.43, -0.42);
    box(0.08, 0.08, 0.14, black, sx * (CABIN_W / 2 + 0.06), 0.32, 0.58); // mirror
    box(0.02, 0.05, 2.0, satin, sx * (WIDTH / 2 + 0.005), -0.42, 0); // side skirt

    // Slim angular headlamp, lamp-to-lamp bar between them; wraparound tails.
    const lamp = box(0.42, 0.07, 0.03, head, sx * 0.6, 0.03, FRONT + 0.0);
    lamp.rotation.z = sx * -0.08;
    box(0.34, 0.09, 0.03, tail, sx * 0.66, 0.16, BACK - 0.01);
    box(0.03, 0.09, 0.2, tail, sx * (WIDTH / 2 + 0.005), 0.16, BACK + 0.1);
    box(0.32, 0.12, 0.05, black, sx * 0.6, -0.18, FRONT + 0.0); // corner vent
    tube(0.045, 0.12, satin, sx * 0.62, -0.42, BACK - 0.03, 10).userData.exhaust = true; // one tailpipe per side
  }
  box(0.66, 0.035, 0.03, satin, 0, 0.04, FRONT + 0.02); // grille bar
  box(0.7, 0.13, 0.04, black, 0, -0.2, FRONT + 0.0); // lower intake
  box(1.3, 0.04, 0.12, bodyMat, 0, 0.33, BACK + 0.08).rotation.x = -0.25; // ducktail
  box(1.5, 0.1, 0.06, black, 0, -0.38, BACK - 0.01); // diffuser
  box(0.52, 0.11, 0.012, plate, 0, -0.07, FRONT + 0.03);
  box(0.52, 0.11, 0.012, plate, 0, 0.0, BACK - 0.02);

  return { group, bodyMat };
}
