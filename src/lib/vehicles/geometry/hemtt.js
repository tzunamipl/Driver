import * as THREE from 'three';
import { createGlossyMaterial, createPaintMaterial } from './paint.js';

// Oshkosh M977 HEMTT cargo truck, low-poly. Chassis-local, origin at the
// centre of mass (~1.15 m above the ground at rest); +z forward, 10.2 m long,
// 2.44 m wide. Wheels are separate meshes (see ../hemtt.js axles): their
// tops sit near y = 0.1, so the cab and bed clear them at full bump.
const LENGTH = 10.2;
const WIDTH = 2.44;
const FRONT = LENGTH / 2;
const BACK = -LENGTH / 2;

export function buildBody(_chassisWidth, _chassisLength, color = 0x4b5320) {
  const group = new THREE.Group();

  const bodyMat = createPaintMaterial(color, { metalness: 0.1, roughness: 0.85 });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x1d1f1a, metalness: 0.3, roughness: 0.8 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0x5b5d58, metalness: 0.7, roughness: 0.5 });
  const glassMat = createGlossyMaterial({ color: 0x1b2228, metalness: 0.5, roughness: 0.15 });
  const lightMat = createGlossyMaterial({ color: 0xfff3cf, emissive: 0x554417, roughness: 0.3, userData: { lamp: 'head' } });
  const markerMat = new THREE.MeshStandardMaterial({ color: 0xff8a1a, emissive: 0x803000, roughness: 0.4 });

  const add = (geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  };
  const box = (w, h, d, material, x, y, z) => add(new THREE.BoxGeometry(w, h, d), material, x, y, z);

  // Ladder frame + front bumper / tow pintle.
  for (const sx of [-1, 1]) box(0.25, 0.35, LENGTH - 0.4, frameMat, sx * 0.5, -0.32, -0.1);
  box(WIDTH, 0.32, 0.25, frameMat, 0, -0.4, FRONT - 0.15);
  box(WIDTH * 0.9, 0.2, 0.2, frameMat, 0, -0.4, BACK + 0.12);

  // Short sloped hood + brush-guard grille ahead of the cab.
  box(WIDTH * 0.92, 0.75, 0.85, bodyMat, 0, 0.62, FRONT - 0.65);
  box(WIDTH * 0.8, 0.7, 0.08, frameMat, 0, 0.0, FRONT - 0.3);
  const hoodSlope = box(WIDTH * 0.92, 0.08, 0.95, bodyMat, 0, 1.08, FRONT - 0.9);
  hoodSlope.rotation.x = 0.35;
  for (const sx of [-1, 1]) {
    const lamp = new THREE.CylinderGeometry(0.11, 0.11, 0.06, 12);
    lamp.rotateX(Math.PI / 2);
    add(lamp, lightMat, sx * 0.85, 0.55, FRONT - 0.2);
    box(0.12, 0.06, 0.04, markerMat, sx * 1.05, 1.0, FRONT - 0.22);
  }

  // Flat-faced two-door cab, high over the front axles.
  const cabFront = FRONT - 1.05;
  const cabBack = 2.3;
  const cabLen = cabFront - cabBack;
  const cabZ = (cabFront + cabBack) / 2;
  box(WIDTH, 1.45, cabLen, bodyMat, 0, 1.05, cabZ);
  box(WIDTH * 0.84, 0.62, 0.04, glassMat, 0, 1.38, cabFront + 0.01);
  for (const sx of [-1, 1]) {
    box(0.04, 0.5, cabLen * 0.45, glassMat, sx * (WIDTH / 2 + 0.01), 1.42, cabZ + cabLen * 0.15);
    box(0.06, 0.35, 0.06, steelMat, sx * (WIDTH / 2 + 0.12), 1.4, cabFront - 0.05); // mirror arm
    box(0.04, 0.4, 0.25, glassMat, sx * (WIDTH / 2 + 0.16), 1.45, cabFront - 0.1);
    box(0.5, 0.06, 0.3, frameMat, sx * (WIDTH / 2 - 0.25), 0.25, cabZ + 0.3); // step
  }
  box(WIDTH * 0.7, 0.1, cabLen * 0.6, bodyMat, 0, 1.82, cabZ); // roof hatch ring
  box(0.9, 0.08, 0.1, markerMat, 0, 1.79, cabFront - 0.02);

  // Behind the cab: air intake, exhaust stack, spare-tyre carrier.
  box(0.5, 1.2, 0.5, bodyMat, 0.75, 1.0, cabBack - 0.35);
  const stack = new THREE.CylinderGeometry(0.08, 0.08, 1.7, 10);
  add(stack, steelMat, -0.95, 1.25, cabBack - 0.3);
  box(1.0, 0.6, 0.35, frameMat, -0.2, 0.75, cabBack - 0.4);

  // Saddle fuel tank (left) and battery/tool box (right) between the axle pairs.
  const tank = new THREE.CylinderGeometry(0.32, 0.32, 1.5, 14);
  tank.rotateX(Math.PI / 2);
  add(tank, steelMat, 0.92, -0.3, 0);
  box(0.5, 0.55, 1.2, bodyMat, -0.95, -0.3, 0);

  // Flatbed cargo body with drop sides over the rear tandem.
  const bedFront = cabBack - 0.75;
  const bedLen = bedFront - BACK;
  const bedZ = (bedFront + BACK) / 2;
  box(WIDTH, 0.14, bedLen, bodyMat, 0, 0.5, bedZ);
  for (const sx of [-1, 1]) box(0.06, 0.55, bedLen, bodyMat, sx * (WIDTH / 2 - 0.03), 0.84, bedZ);
  box(WIDTH, 0.55, 0.06, bodyMat, 0, 0.84, BACK + 0.03);
  box(WIDTH, 0.9, 0.08, bodyMat, 0, 1.02, bedFront - 0.04); // headboard
  for (const sx of [-1, 1]) {
    box(0.1, 0.06, 0.04, markerMat, sx * 1.0, 0.3, BACK - 0.01);
    box(0.35, 0.5, 0.04, frameMat, sx * 0.95, -0.55, BACK + 0.35); // mud flap
  }

  return { group, bodyMat };
}
