import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';

// Death Tanker, low-poly: a 6x6 tractor with a 1940s cab, a long
// hood carrying twin blown V8s and a spiked ram, towing a fuel tanker.
// Both are chassis-local with the origin at the centre of mass (~1.1 m above
// the ground at rest), +z forward; wheel tops sit near y = 0.

function createKit(group) {
  const add = (geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };
  const box = (w, h, d, material, x, y, z) => add(new THREE.BoxGeometry(w, h, d), material, x, y, z);
  /** Cylinder along z. */
  const tube = (r, len, material, x, y, z, segments = 12) => {
    const g = new THREE.CylinderGeometry(r, r, len, segments);
    g.rotateX(Math.PI / 2);
    return add(g, material, x, y, z);
  };
  /** Cone pointing along `dir` ('x', '-x', 'y', 'z', '-z'). */
  const spike = (r, len, material, x, y, z, dir) => {
    const g = new THREE.ConeGeometry(r, len, 6);
    if (dir === 'z') g.rotateX(Math.PI / 2);
    if (dir === '-z') g.rotateX(-Math.PI / 2);
    if (dir === 'x') g.rotateZ(-Math.PI / 2);
    if (dir === '-x') g.rotateZ(Math.PI / 2);
    return add(g, material, x, y, z);
  };
  return { add, box, tube, spike };
}

function materials() {
  return {
    rust: new THREE.MeshStandardMaterial({ color: 0x6e3417, metalness: 0.4, roughness: 0.85 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x1b1a18, metalness: 0.4, roughness: 0.8 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xc9c4b8, metalness: 0.9, roughness: 0.25 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x6f6a62, metalness: 0.7, roughness: 0.55 }),
    glass: createGlossyMaterial({ color: 0x15130f, metalness: 0.5, roughness: 0.2 }),
    light: createGlossyMaterial({ color: 0xfff1c8, emissive: 0x554417, roughness: 0.3, userData: { lamp: 'head' } }),
  };
}

/** Tractor unit; `color` paints the cab, hood and fenders. */
export function buildBody(_chassisWidth, _chassisLength, color = 0x1f1c1a) {
  const group = new THREE.Group();
  const m = materials();
  const bodyMat = createPaintMaterial(color, { metalness: 0.35, roughness: 0.6 });
  const { add, box, tube, spike } = createKit(group);

  // Ladder frame and fifth-wheel deck (hitch at z = -2.2, see ../deathTanker.js).
  for (const sx of [-1, 1]) box(0.25, 0.32, 8.2, m.frame, sx * 0.5, -0.32, 0.2);
  box(2.2, 0.1, 3.4, m.steel, 0, 0.32, -2.2);
  add(new THREE.CylinderGeometry(0.75, 0.75, 0.1, 16), m.frame, 0, 0.42, -2.2);

  // Spiked ram + bull bar across the front.
  box(2.5, 0.85, 0.3, m.rust, 0, -0.15, 4.6);
  for (let i = -2; i <= 2; i++) spike(0.07, 0.55, m.steel, i * 0.5, 0.05, 5.0, 'z');
  for (let i = -2; i <= 2; i++) spike(0.06, 0.45, m.steel, i * 0.5 + 0.25, -0.4, 4.95, 'z');
  add(new THREE.CylinderGeometry(0.07, 0.07, 2.5, 10).rotateZ(Math.PI / 2), m.chrome, 0, 0.45, 4.45);

  // Long hood over the front axle, rounded 1940s fenders.
  box(1.5, 0.9, 2.9, bodyMat, 0, 0.75, 2.85);
  box(1.4, 0.75, 0.12, m.chrome, 0, 0.7, 4.32); // grille
  for (let i = 0; i < 6; i++) box(1.3, 0.04, 0.02, m.frame, 0, 0.42 + i * 0.12, 4.39);
  for (const sx of [-1, 1]) {
    // Open half-tube arching over the wheel (axis along x).
    const fender = new THREE.CylinderGeometry(0.75, 0.75, 0.5, 14, 1, true, 0, Math.PI).rotateZ(Math.PI / 2);
    add(fender, bodyMat, sx * 1.0, -0.35, 3.0);
    box(0.55, 0.06, 1.5, bodyMat, sx * 1.0, 0.34, 1.65); // running board
    tube(0.15, 0.08, m.light, sx * 0.95, 0.85, 4.1, 14);
  }

  // Twin supercharged V8s: blower cases, belts and intake scoops on top.
  for (const sx of [-1, 1]) {
    box(0.42, 0.42, 0.75, m.chrome, sx * 0.38, 1.4, 2.9);
    box(0.3, 0.32, 0.4, m.frame, sx * 0.38, 1.75, 3.05);
    box(0.2, 0.36, 0.06, m.frame, sx * 0.38, 1.3, 3.32); // belt
    for (let i = 0; i < 4; i++) {
      tube(0.05, 0.4, m.rust, sx * 0.85, 0.6, 2.2 + i * 0.4).rotation.z = sx * 0.3; // headers
    }
  }

  // Chevy Fleetmaster cab: rounded roof, split windscreen, rust patches.
  box(2.1, 1.0, 1.7, bodyMat, 0, 0.8, 0.55);
  box(1.9, 0.62, 1.4, bodyMat, 0, 1.6, 0.45);
  const roof = new THREE.CylinderGeometry(0.95, 0.95, 1.4, 16, 1, false, -Math.PI / 2, Math.PI);
  roof.rotateX(-Math.PI / 2).scale(1, 0.25, 1); // half-round on top, flattened
  add(roof, bodyMat, 0, 1.91, 0.45);
  for (const sx of [-1, 1]) {
    box(0.8, 0.45, 0.04, m.glass, sx * 0.44, 1.65, 1.16);
    box(0.04, 0.42, 0.9, m.glass, sx * 0.96, 1.65, 0.5);
  }
  box(0.9, 0.5, 0.05, m.rust, 0.4, 0.85, 1.42);
  box(0.05, 0.6, 0.7, m.rust, -1.06, 0.7, 0.3);

  // Roof gunner nest + spikes, twin exhaust stacks behind the cab.
  box(1.2, 0.08, 0.9, m.rust, 0, 2.18, 0.2);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) spike(0.04, 0.4, m.steel, sx * 0.55, 2.42, 0.2 + sz * 0.4, 'y');
  for (const sx of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.11, 0.11, 2.4, 12), m.chrome, sx * 1.15, 1.45, -0.55);
    spike(0.13, 0.25, m.rust, sx * 1.15, 2.75, -0.55, 'y');
  }

  // Rear deck: side tanks, spare tyre, door spikes.
  for (const sx of [-1, 1]) {
    tube(0.3, 1.1, m.steel, sx * 0.95, -0.25, -0.75);
    for (let i = 0; i < 3; i++) spike(0.05, 0.35, m.steel, sx * 1.12, 0.9, 0.0 + i * 0.4, sx > 0 ? 'x' : '-x');
  }
  box(1.6, 0.2, 0.2, m.frame, 0, -0.35, -3.95);

  return { group, bodyMat };
}

/** Fuel tanker semi-trailer; kingpin at z = 4.2 on its front underside. */
export function buildTrailer() {
  const group = new THREE.Group();
  const m = materials();
  const tankMat = new THREE.MeshStandardMaterial({ color: 0x8c8a84, metalness: 0.75, roughness: 0.45 });
  const { add, box, tube, spike } = createKit(group);

  // Gooseneck + main beams; front upper coupler rests on the fifth wheel.
  for (const sx of [-1, 1]) box(0.22, 0.3, 9.4, m.frame, sx * 0.5, 0.55, -0.2);
  box(2.0, 0.12, 1.4, m.steel, 0, 0.46, 4.0);
  box(2.4, 0.16, 3.4, m.frame, 0, 0.3, -3.3); // axle bogie subframe

  // Tank barrel with end caps, saddles, catwalk and ladder.
  tube(1.05, 8.6, tankMat, 0, 1.75, -0.6, 20);
  // Shallow dished end caps: a +y hemisphere turned to face +z / -z, then flattened.
  const cap = (dir) => new THREE.SphereGeometry(1.05, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(dir * Math.PI / 2).scale(1, 1, 0.35);
  add(cap(1), tankMat, 0, 1.75, 3.7);
  add(cap(-1), tankMat, 0, 1.75, -4.9);
  for (const z of [-3.6, -0.6, 2.4]) {
    box(2.2, 0.08, 0.2, m.rust, 0, 2.82, z); // strap
    box(1.8, 0.5, 0.25, m.frame, 0, 0.85, z); // saddle
  }
  box(0.6, 0.06, 8.2, m.steel, 0, 2.86, -0.6);
  for (const z of [-3.0, 0.0, 2.6]) tube(0.28, 0.25, m.frame, 0, 2.92, z).rotation.x = Math.PI / 2; // manholes
  for (const sx of [-1, 1]) box(0.04, 0.5, 8.2, m.chrome, sx * 0.3, 3.1, -0.6); // rails
  for (let i = 0; i < 8; i++) box(0.5, 0.04, 0.04, m.steel, 0, 0.9 + i * 0.25, -5.25);

  // Spikes along the tank flanks, rust streaks, landing legs, rear bumper.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 5; i++) spike(0.06, 0.45, m.steel, sx * 1.2, 1.4, -4.0 + i * 1.8, sx > 0 ? 'x' : '-x');
    box(0.04, 1.2, 0.5, m.rust, sx * 1.04, 1.5, 1.2);
    box(0.12, 0.7, 0.12, m.frame, sx * 0.7, 0.05, 2.6);
    box(0.3, 0.45, 0.04, m.frame, sx * 0.95, -0.35, -5.05); // mud flap
  }
  box(2.3, 0.18, 0.18, m.rust, 0, -0.2, -5.1);
  for (const sx of [-1, 1]) box(0.14, 0.06, 0.04, m.light, sx * 1.0, -0.05, -5.2);

  return { group, bodyMat: tankMat };
}
