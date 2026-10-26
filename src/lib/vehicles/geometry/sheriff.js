import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { createKit, sideOutline } from './kit.js';

// Sheriff: full-size American pickup, low-poly: tall square nose with a big
// chrome grille, extended cab, open bed with tailgate. Chassis-local, +z
// forward, 5.5 m long; ground near y = -0.87. Axle positions must match ../sheriff.js.

export const AXLES_Z = [1.75, -1.75];
const ARCH = { y: -0.4, r: 0.46 };
const FRONT = 2.75;
const BACK = -2.75;
const WIDTH = 2.0;
const CABIN_W = 1.84;
const CAB_BACK = -0.78;

export function buildBody(_chassisWidth, _chassisLength, color = 0x1d2a3a) {
  const group = new THREE.Group();
  const bodyMat = createPaintMaterial(color, { metalness: 0.3, roughness: 0.4 });
  const black = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 });
  const chrome = createGlossyMaterial({ color: 0xdadde2, metalness: 1, roughness: 0.14 });
  const glass = createGlossyMaterial({ color: 0x10161b, metalness: 0.5, roughness: 0.1 });
  const head = createGlossyMaterial({ color: 0xf4f6fa, emissive: 0x403418, roughness: 0.2, userData: { lamp: 'head' } });
  const tail = createGlossyMaterial({ color: 0xb0101a, emissive: 0x400000, roughness: 0.3, userData: { lamp: 'tail' } });
  const amber = new THREE.MeshStandardMaterial({ color: 0xe08a1a, emissive: 0x3a1c00, roughness: 0.4 });
  const plate = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 });
  const { box, fender, profile } = createKit(group);
  const [frontArch, rearArch] = AXLES_Z.map((z) => ({ z, ...ARCH }));

  // Front end + cab floor up to the cab's back wall.
  const nose = [[FRONT, -0.3], [FRONT, 0.32], [FRONT - 0.08, 0.4], [0.8, 0.44], [CAB_BACK, 0.46], [CAB_BACK, -0.3]];
  profile(sideOutline(nose, -0.38, [frontArch]), WIDTH, bodyMat);
  const cabin = [[0.8, 0.44], [0.3, 1.02], [-0.68, 1.04], [CAB_BACK + 0.02, 0.46]];
  profile(cabin, CABIN_W, bodyMat);
  const ws = box(CABIN_W - 0.12, 0.02, Math.hypot(0.5, 0.58), glass, 0, 0.74, 0.55);
  ws.rotation.x = Math.atan2(0.58, 0.5);
  box(CABIN_W - 0.4, 0.38, 0.02, glass, 0, 0.78, CAB_BACK);

  // Open bed: two side walls cut by the rear arch, floor, wheel tubs, tailgate.
  const bedSide = [[CAB_BACK - 0.03, -0.3], [CAB_BACK - 0.03, 0.46], [BACK, 0.46], [BACK, -0.3]];
  for (const sx of [-1, 1]) profile(sideOutline(bedSide, -0.38, [rearArch]), 0.08, bodyMat, sx * (WIDTH / 2 - 0.04));
  const bedLen = CAB_BACK - 0.03 - BACK;
  const bedZ = BACK + bedLen / 2;
  box(WIDTH - 0.16, 0.05, bedLen, black, 0, 0.0, bedZ);
  box(WIDTH - 0.16, 0.44, 0.04, bodyMat, 0, 0.22, CAB_BACK - 0.05);
  for (const sx of [-1, 1]) box(0.3, 0.26, 1.0, black, sx * (WIDTH / 2 - 0.23), 0.14, rearArch.z);
  box(WIDTH - 0.16, 0.5, 0.06, bodyMat, 0, 0.2, BACK + 0.03);
  box(1.0, 0.36, 0.5, black, 0, -0.2, bedZ); // frame under the bed
  for (const z of AXLES_Z) for (const sx of [-1, 1]) fender(ARCH.r + 0.03, 0.1, black, sx * (WIDTH / 2 + 0.01), ARCH.y, z);

  for (const sx of [-1, 1]) {
    const x = sx * (CABIN_W / 2 + 0.005);
    profile([[0.68, 0.54], [0.3, 0.96], [-0.15, 0.97], [-0.15, 0.54]], 0.02, glass, x);
    profile([[-0.25, 0.54], [-0.25, 0.97], [-0.62, 0.97], [-0.66, 0.54]], 0.02, glass, x);
    box(0.08, 0.22, 0.2, black, sx * (CABIN_W / 2 + 0.1), 0.62, 0.66); // towing mirror
    box(0.05, 0.05, 1.6, black, sx * (WIDTH / 2 + 0.08), -0.36, 0.0); // running board

    // Stacked square headlamps beside the grille, tall taillights on the bed corners.
    box(0.3, 0.22, 0.04, head, sx * 0.78, 0.12, FRONT + 0.02);
    box(0.12, 0.1, 0.04, amber, sx * 0.94, -0.06, FRONT + 0.02);
    box(0.1, 0.36, 0.03, tail, sx * (WIDTH / 2 - 0.06), 0.24, BACK - 0.015);
  }

  // Chrome grille, chrome bumpers.
  box(1.2, 0.42, 0.04, chrome, 0, 0.12, FRONT + 0.02);
  box(1.04, 0.3, 0.045, black, 0, 0.12, FRONT + 0.025);
  box(0.06, 0.3, 0.05, chrome, 0, 0.12, FRONT + 0.03);
  box(WIDTH + 0.04, 0.2, 0.16, chrome, 0, -0.22, FRONT + 0.06);
  box(WIDTH, 0.18, 0.18, chrome, 0, -0.2, BACK - 0.06);
  box(0.52, 0.11, 0.012, plate, 0, -0.22, FRONT + 0.145);
  box(0.52, 0.11, 0.012, plate, 0, 0.03, BACK - 0.005);

  return { group, bodyMat };
}
