import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';
import { createKit } from './kit.js';

// Immortan Joe's Gigahorse (Fury Road), low-poly: two 1959 Cadillac Coupe de
// Ville bodies stacked on a raised chassis, twin blown V8s through the hood,
// giant tractor tyres out back. Chassis-local, origin at the centre of mass
// (~1.2 m above the ground at rest), +z forward. Axle positions must match
// ../gigahorse.js; the rear tyres sit outboard of the bodies.

const FRONT_AXLE_Z = 2.0;
const REAR_AXLE_Z = -2.0;
const ARCH_R = 0.64;

/** One Cadillac shell: slab body, tail fins with bullet lamps, chrome strip. */
function cadillac(kit, m, bodyMat, { front, back, width, bottom, top }) {
  const { box, profile, add } = kit;
  const len = front - back;
  box(width, top - bottom, len, bodyMat, 0, (top + bottom) / 2, (front + back) / 2);
  for (const sx of [-1, 1]) {
    const finTop = top + 0.42;
    profile([[back + 1.4, top], [back, top], [back - 0.05, finTop], [back + 0.35, finTop - 0.08]], 0.1, bodyMat, sx * (width / 2 - 0.08));
    for (const dy of [0, 0.1]) add(new THREE.SphereGeometry(0.06, 10, 6), m.tail, sx * (width / 2 - 0.08), finTop - 0.14 - dy, back - 0.03);
    box(0.02, 0.04, len * 0.8, m.chrome, sx * (width / 2 + 0.01), (top + bottom) / 2, (front + back) / 2 - len * 0.05);
  }
  box(width + 0.05, 0.14, 0.14, m.chrome, 0, bottom + 0.05, back - 0.05); // rear bumper
}

export function buildBody(_chassisWidth, _chassisLength, color = 0x15120f) {
  const group = new THREE.Group();
  const kit = createKit(group);
  const { add, box, tube, fender } = kit;
  const bodyMat = createPaintMaterial(color, { metalness: 0.25, roughness: 0.45 });
  const m = {
    frame: new THREE.MeshStandardMaterial({ color: 0x1a1816, metalness: 0.4, roughness: 0.75 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xd9d6cf, metalness: 0.95, roughness: 0.18 }),
    leather: new THREE.MeshStandardMaterial({ color: 0x3b2418, roughness: 0.8 }),
    bone: new THREE.MeshStandardMaterial({ color: 0xe6dcc4, roughness: 0.6 }),
    glass: createGlossyMaterial({ color: 0x1a2026, metalness: 0.4, roughness: 0.1 }),
    head: createGlossyMaterial({ color: 0xfff1c8, emissive: 0x554417, roughness: 0.3, userData: { lamp: 'head' } }),
    tail: createGlossyMaterial({ color: 0xd01018, emissive: 0x500000, roughness: 0.3, userData: { lamp: 'tail' } }),
  };

  // Chassis: frame rails, rear axle tube out to the outboard tractor tyres.
  for (const sx of [-1, 1]) box(0.2, 0.25, 5.6, m.frame, sx * 0.55, -0.5, 0);
  add(new THREE.CylinderGeometry(0.12, 0.12, 2.3, 12).rotateZ(Math.PI / 2), m.frame, 0, -0.33, REAR_AXLE_Z);
  for (const sx of [-1, 1]) box(0.3, 0.3, 0.5, m.frame, sx * 1.0, -0.33, REAR_AXLE_Z); // hubs

  // Lower Cadillac, open arches over the front wheels.
  const lowFront = 3.0;
  const lowBack = -2.8;
  cadillac(kit, m, bodyMat, { front: lowFront, back: lowBack, width: 2.0, bottom: 0.0, top: 0.3 });
  box(2.0, 0.35, lowFront - (FRONT_AXLE_Z + ARCH_R), bodyMat, 0, -0.17, (lowFront + FRONT_AXLE_Z + ARCH_R) / 2);
  box(2.0, 0.35, FRONT_AXLE_Z - ARCH_R - lowBack, bodyMat, 0, -0.17, (FRONT_AXLE_Z - ARCH_R + lowBack) / 2);
  box(1.3, 0.35, ARCH_R * 2, m.frame, 0, -0.17, FRONT_AXLE_Z);
  for (const sx of [-1, 1]) fender(ARCH_R + 0.04, 0.45, m.frame, sx * 0.98, -0.05, FRONT_AXLE_Z);

  // '59 face: chrome grille, quad lamps, bumper with bullet guards.
  box(1.5, 0.22, 0.05, m.chrome, 0, 0.05, lowFront + 0.02);
  for (const sx of [-1, 1]) {
    for (const x of [0.62, 0.84]) tube(0.08, 0.05, m.head, sx * x, 0.12, lowFront + 0.02);
    kit.spike(0.07, 0.25, m.chrome, sx * 0.4, -0.2, lowFront + 0.2, 'z');
  }
  box(2.1, 0.16, 0.16, m.chrome, 0, -0.2, lowFront + 0.06);

  // Upper Cadillac, stacked and set back, open-topped: wraparound windscreen, throne, wheel.
  const upFront = 2.2;
  const upBack = -2.5;
  cadillac(kit, m, bodyMat, { front: upFront, back: upBack, width: 1.95, bottom: 0.3, top: 0.75 });
  const screen = box(1.7, 0.45, 0.03, m.glass, 0, 1.0, 0.45);
  screen.rotation.x = -0.35;
  for (const sx of [-1, 1]) box(0.04, 0.48, 0.04, m.chrome, sx * 0.86, 1.0, 0.45).rotation.x = -0.35;
  box(0.8, 0.12, 0.6, m.leather, 0, 0.83, -0.35);
  box(0.8, 0.75, 0.15, m.leather, 0, 1.15, -0.68);
  add(new THREE.TorusGeometry(0.19, 0.025, 6, 16), m.chrome, 0, 1.05, 0.1).rotation.x = -0.5;

  // Twin blown V8s through the hood: blocks, blower cases, scoops; skull ornament.
  for (const sx of [-1, 1]) {
    box(0.55, 0.45, 0.85, m.frame, sx * 0.42, 0.95, 1.65);
    box(0.4, 0.3, 0.6, m.chrome, sx * 0.42, 1.32, 1.7);
    box(0.34, 0.2, 0.4, m.frame, sx * 0.42, 1.57, 1.75);
    box(0.06, 0.4, 0.06, m.frame, sx * 0.42, 1.05, 2.08); // belt
    // Exhaust stacks rising behind the engines.
    for (let i = 0; i < 3; i++) {
      const pipe = add(new THREE.CylinderGeometry(0.06, 0.07, 1.3, 10), m.chrome, sx * (0.78 + i * 0.07), 1.25, 1.35 - i * 0.18);
      pipe.rotation.x = -0.2;
      pipe.rotation.z = sx * -0.12;
    }
  }
  add(new THREE.SphereGeometry(0.13, 12, 8), m.bone, 0, 0.88, upFront + 0.05);
  for (const sx of [-1, 1]) add(new THREE.SphereGeometry(0.03, 6, 4), m.frame, sx * 0.05, 0.9, upFront + 0.16);

  return { group, bodyMat };
}
