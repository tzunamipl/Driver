import * as THREE from 'three';
import { createGlossyMaterial } from './paint.js';

// Shared low-poly pieces for European cab-over trucks (./scaniaR.js,
// ./actros.js). Chassis-local, +z forward, wheel tops near y = 0 at rest.

export function truckMaterials() {
  return {
    frame: new THREE.MeshStandardMaterial({ color: 0x1c1d1f, metalness: 0.35, roughness: 0.75 }),
    plastic: new THREE.MeshStandardMaterial({ color: 0x2a2b2d, metalness: 0.1, roughness: 0.7 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x8a8d90, metalness: 0.8, roughness: 0.4 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xd8dadc, metalness: 0.95, roughness: 0.2 }),
    glass: createGlossyMaterial({ color: 0x141b22, metalness: 0.5, roughness: 0.12 }),
    head: createGlossyMaterial({ color: 0xf4f6ff, emissive: 0x404455, roughness: 0.2, userData: { lamp: 'head' } }),
    tail: createGlossyMaterial({ color: 0xc8141c, emissive: 0x400000, roughness: 0.3, userData: { lamp: 'tail' } }),
    amber: new THREE.MeshStandardMaterial({ color: 0xff9a1a, emissive: 0x6a3000, roughness: 0.4 }),
  };
}

/**
 * Cab-over cab sitting over the front axle at `axleZ`. `front` = front face z,
 * `depth` front to back, `roofY` cab top; the lower front wraps the wheel in
 * a black arch. `grille` picks the face: 'scania' (tall slatted) or 'actros'
 * (wide chrome bars).
 */
export function buildCab(kit, m, bodyMat, { front, depth, axleZ, roofY, width = 2.5, grille = 'scania' }) {
  const { box, fender } = kit;
  const back = front - depth;
  const half = width / 2;
  const floorY = 0.15;
  const cabH = roofY - floorY;
  const cabZ = front - depth / 2;

  // Upper cab, windscreen + side windows, sun visor.
  box(width, cabH, depth, bodyMat, 0, floorY + cabH / 2, cabZ);
  box(width - 0.2, 0.95, 0.04, m.glass, 0, 1.55, front + 0.01);
  box(width + 0.04, 0.12, 0.04, m.plastic, 0, 1.03, front + 0.02); // wiper cowl
  for (const sx of [-1, 1]) {
    box(0.04, 0.75, 0.85, m.glass, sx * (half + 0.01), 1.5, front - 0.55);
    box(0.06, 0.06, 0.45, m.plastic, sx * (half + 0.2), 1.95, front - 0.15); // mirror arm
    box(0.06, 0.55, 0.28, m.plastic, sx * (half + 0.42), 1.65, front - 0.15);
    box(0.04, 0.5, 0.22, m.glass, sx * (half + 0.42), 1.65, front - 0.12);
    box(0.06, 1.8, 0.35, bodyMat, sx * (half + 0.02), floorY + 1.0 + 0.6, back + 0.15); // side extender
  }
  box(width, 0.1, 0.35, bodyMat, 0, 2.12, front + 0.12); // visor
  for (let i = -2; i <= 2; i++) box(0.22, 0.12, 0.08, i % 2 ? m.amber : m.head, i * 0.4, 2.24, front + 0.24);

  // Grille and bumper below the windscreen.
  if (grille === 'scania') {
    box(1.7, 0.85, 0.06, m.frame, 0, 0.55, front + 0.02);
    for (let i = 0; i < 5; i++) box(1.6, 0.05, 0.03, m.steel, 0, 0.22 + i * 0.17, front + 0.06);
    box(0.32, 0.12, 0.04, m.chrome, 0, 0.98, front + 0.05); // badge
  } else {
    box(1.9, 0.8, 0.06, m.frame, 0, 0.55, front + 0.02);
    for (let i = 0; i < 3; i++) box(1.85, 0.08, 0.05, m.chrome, 0, 0.3 + i * 0.25, front + 0.06);
    box(0.36, 0.36, 0.05, m.chrome, 0, 0.55, front + 0.09); // star disc
  }

  // Lower front: bumper with headlamps, steps behind the front wheel, engine tunnel between.
  const wheelFront = axleZ + 0.62;
  const wheelBack = axleZ - 0.62;
  const bumperDepth = front - wheelFront;
  box(width, 0.9, bumperDepth, bodyMat, 0, -0.3, front - bumperDepth / 2);
  box(width + 0.02, 0.3, bumperDepth + 0.02, m.plastic, 0, -0.62, front - bumperDepth / 2);
  for (const sx of [-1, 1]) {
    box(0.55, 0.2, 0.04, m.head, sx * 0.85, -0.15, front + 0.01);
    box(0.18, 0.08, 0.04, m.amber, sx * 1.12, -0.15, front + 0.01);
  }
  const stepDepth = wheelBack - back;
  if (stepDepth > 0.05) {
    box(width, 0.75, stepDepth, bodyMat, 0, -0.23, back + stepDepth / 2);
    for (const sx of [-1, 1]) for (let i = 0; i < 2; i++) box(0.3, 0.04, stepDepth * 0.8, m.steel, sx * (half - 0.15), -0.45 + i * 0.3, back + stepDepth / 2);
  }
  box(1.4, 0.75, wheelFront - wheelBack, m.frame, 0, -0.23, axleZ);
  for (const sx of [-1, 1]) fender(0.62, 0.42, m.plastic, sx * 1.02, -0.5, axleZ);
}

/** Black arch over a (dual) rear wheel set. */
export function rearMudguard(kit, m, x, z, length = 1.3) {
  kit.box(0.7, 0.05, length, m.plastic, x, 0.12, z);
  kit.box(0.6, 0.55, 0.04, m.frame, x, -0.45, z - length / 2); // mud flap
}
