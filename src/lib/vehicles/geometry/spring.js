import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { createKit, sideOutline } from './kit.js';

// Spring: boxy three-box saloon on stilts, low-poly, with a coil spring
// and ball sprouting from the boot lid. Chassis-local, +z forward, 4.6 m
// long; ground near y = -0.8. Axle positions must match ../spring.js.

export const AXLES_Z = [1.35, -1.35];
const ARCH = { y: -0.42, r: 0.4 };
const FRONT = 2.3;
const BACK = -2.3;
const WIDTH = 1.74;
const CABIN_W = 1.56;

export function buildBody(_chassisWidth, _chassisLength, color = 0x3f8f5a) {
  const group = new THREE.Group();
  const bodyMat = createPaintMaterial(color, { metalness: 0.1, roughness: 0.55 });
  const black = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.85 });
  const chrome = createGlossyMaterial({ color: 0xd4d6da, metalness: 1, roughness: 0.18 });
  const glass = createGlossyMaterial({ color: 0x12181d, metalness: 0.5, roughness: 0.12 });
  const head = createGlossyMaterial({ color: 0xf4f2e8, emissive: 0x403418, roughness: 0.2, userData: { lamp: 'head' } });
  const tail = createGlossyMaterial({ color: 0xa8121a, emissive: 0x2a0000, roughness: 0.25, userData: { lamp: 'tail' } });
  const plate = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });
  const ball = new THREE.MeshStandardMaterial({ color: 0xe8361c, roughness: 0.4 });
  const { add, box, profile } = createKit(group);

  const top = [[FRONT, -0.36], [FRONT, 0.1], [FRONT - 0.05, 0.14], [0.95, 0.17], [-1.55, 0.2], [BACK + 0.03, 0.2], [BACK, 0.1], [BACK, -0.36]];
  const arches = AXLES_Z.map((z) => ({ z, ...ARCH }));
  profile(sideOutline(top, -0.56, arches), WIDTH, bodyMat);
  box(WIDTH - 0.5, 0.3, FRONT - BACK - 0.3, black, 0, -0.44, 0);

  const cabin = [[0.95, 0.17], [0.45, 0.68], [-1.0, 0.68], [-1.55, 0.2]];
  profile(cabin, CABIN_W, bodyMat);
  const pane = (w, a, b) => {
    const len = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const mesh = box(w, 0.02, len, glass, 0, (a[1] + b[1]) / 2 + 0.01, (a[0] + b[0]) / 2);
    mesh.rotation.x = Math.atan2(b[1] - a[1], a[0] - b[0]);
    return mesh;
  };
  pane(CABIN_W - 0.12, cabin[0], cabin[1]);
  pane(CABIN_W - 0.14, cabin[3], cabin[2]);
  for (const sx of [-1, 1]) {
    const x = sx * (CABIN_W / 2 + 0.005);
    profile([[0.82, 0.25], [0.42, 0.64], [-0.22, 0.64], [-0.22, 0.25]], 0.02, glass, x);
    profile([[-0.32, 0.25], [-0.32, 0.64], [-0.98, 0.64], [-1.38, 0.25]], 0.02, glass, x);
    box(0.08, 0.08, 0.12, black, sx * (CABIN_W / 2 + 0.05), 0.3, 0.8); // mirror
    box(0.03, 0.12, FRONT - BACK - 1.0, black, sx * (WIDTH / 2 + 0.01), -0.2, 0); // rubbing strip

    // Square headlamps, plain block taillights.
    box(0.36, 0.17, 0.03, head, sx * 0.58, 0.0, FRONT + 0.015);
    box(0.38, 0.15, 0.03, tail, sx * 0.6, 0.02, BACK - 0.015);
  }
  box(0.7, 0.17, 0.03, black, 0, 0.0, FRONT + 0.015); // grille
  for (const y of [-0.04, 0.04]) box(0.7, 0.015, 0.035, chrome, 0, y, FRONT + 0.02);
  box(WIDTH + 0.04, 0.12, 0.1, black, 0, -0.26, FRONT + 0.04);
  box(WIDTH + 0.04, 0.12, 0.1, black, 0, -0.26, BACK - 0.04);
  box(0.52, 0.11, 0.012, plate, 0, -0.1, BACK - 0.02);

  // Coil spring on the boot lid with a ball on top, kept under the roofline
  // so the fitted cabin hitbox doesn't stretch over the boot.
  const turns = 4;
  const coil = new THREE.Curve();
  coil.getPoint = (t, target = new THREE.Vector3()) =>
    target.set(0.06 * Math.cos(t * turns * Math.PI * 2), t * 0.13, 0.06 * Math.sin(t * turns * Math.PI * 2));
  add(new THREE.TubeGeometry(coil, turns * 12, 0.015, 5), chrome, 0, 0.2, -2.0);
  add(new THREE.SphereGeometry(0.055, 10, 8), ball, 0, 0.37, -2.0);

  return { group, bodyMat };
}
