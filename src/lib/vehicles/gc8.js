// Vehicle definition: Subaru Impreza GC8 (90s WRX/STI rally style).
// Self-contained so this one vehicle can be reskinned/retuned without
// touching the shared rig (physics/wheels/interpolation) in lib/car.js or
// any other vehicle's file - see lib/vehicles/index.js for how these
// per-file descriptors get collected into the selectable roster.

import * as THREE from 'three';

const DEFAULT_BODY_COLOR = 0xffffff; // white

/**
 * Slants the top-front and top-back vertices of a BoxGeometry inward along Z
 * to create a tapered "greenhouse" shape (windshield/rear-window rake),
 * keeping everything low-poly (still just box triangles, no extra geometry).
 */
function taperCabinTop(geometry, frontInset, backInset) {
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (y > 0) {
      if (z > 0) pos.setZ(i, z - frontInset);
      else pos.setZ(i, z + backInset);
    }
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Builds a low-poly Subaru Impreza GC (90s WRX/STI rally-styled) body out of
 * primitive boxes/cylinders: boxy sedan shell, raked cabin greenhouse, hood
 * scoop, round rally fog lights + rectangular headlights, and the iconic
 * STI rear wing on struts. The group stands in for the chassis mesh, sized
 * to roughly match the physics chassis footprint. `color` is the painted
 * shell so a remote car can recolor without rebuilding geometry.
 */
function buildBody(chassisWidth, chassisLength, color = DEFAULT_BODY_COLOR) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.45 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x161616, metalness: 0.2, roughness: 0.8 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x141a20, metalness: 0.6, roughness: 0.15 });
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff3cf, emissive: 0x554417, roughness: 0.3 });
  const fogMat = new THREE.MeshStandardMaterial({ color: 0xffe28a, emissive: 0x7a5410, roughness: 0.3 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x7a0f0f, emissive: 0x3a0000, roughness: 0.4 });

  const parts = [];
  const add = (geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parts.push(mesh);
    return mesh;
  };

  // Main lower body shell.
  add(new THREE.BoxGeometry(chassisWidth, 0.5, chassisLength * 0.9), bodyMat, 0, -0.3, 0);

  // Tapered cabin/greenhouse (windshield rake at front, rear-window rake at back).
  const cabinGeo = taperCabinTop(new THREE.BoxGeometry(chassisWidth * 0.83, 0.55, chassisLength * 0.5), 0.5, 0.35);
  add(cabinGeo, glassMat, 0, 0.175, -0.1);

  // Hood (protrudes slightly past the main shell toward the nose).
  add(new THREE.BoxGeometry(chassisWidth * 0.97, 0.12, chassisLength * 0.28), bodyMat, 0, 0.01, chassisLength * 0.36);

  // Front bumper/nose cap.
  add(new THREE.BoxGeometry(chassisWidth, 0.35, 0.25), trimMat, 0, -0.35, chassisLength * 0.475);

  // Rear trunk deck + bumper.
  add(new THREE.BoxGeometry(chassisWidth * 0.97, 0.15, chassisLength * 0.2), bodyMat, 0, -0.02, -chassisLength * 0.39);
  add(new THREE.BoxGeometry(chassisWidth, 0.3, 0.2), trimMat, 0, -0.35, -chassisLength * 0.4875);

  // Grille + rectangular headlights.
  add(new THREE.BoxGeometry(0.5, 0.15, 0.03), trimMat, 0, -0.15, chassisLength * 0.49);
  add(new THREE.BoxGeometry(0.35, 0.18, 0.05), lightMat, chassisWidth * 0.36, -0.1, chassisLength * 0.49);
  add(new THREE.BoxGeometry(0.35, 0.18, 0.05), lightMat, -chassisWidth * 0.36, -0.1, chassisLength * 0.49);

  // Round rally fog lights (Impreza GC trademark).
  const fogGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.06, 12);
  fogGeo.rotateX(Math.PI / 2);
  add(fogGeo, fogMat, chassisWidth * 0.28, -0.42, chassisLength * 0.5);
  add(fogGeo.clone(), fogMat, -chassisWidth * 0.28, -0.42, chassisLength * 0.5);

  // Taillights.
  add(new THREE.BoxGeometry(0.3, 0.15, 0.05), tailMat, chassisWidth * 0.42, 0, -chassisLength * 0.49);
  add(new THREE.BoxGeometry(0.3, 0.15, 0.05), tailMat, -chassisWidth * 0.42, 0, -chassisLength * 0.49);

  // Hood scoop (WRX icon).
  add(new THREE.BoxGeometry(0.45, 0.08, 0.4), trimMat, 0, 0.11, chassisLength * 0.325);

  // Side mirrors.
  add(new THREE.BoxGeometry(0.1, 0.08, 0.15), bodyMat, chassisWidth * 0.53, 0.15, chassisLength * 0.15);
  add(new THREE.BoxGeometry(0.1, 0.08, 0.15), bodyMat, -chassisWidth * 0.53, 0.15, chassisLength * 0.15);

  // Rear STI wing on struts.
  const strutGeo = new THREE.BoxGeometry(0.05, 0.35, 0.05);
  add(strutGeo, trimMat, chassisWidth * 0.36, 0.2, -chassisLength * 0.46);
  add(strutGeo.clone(), trimMat, -chassisWidth * 0.36, 0.2, -chassisLength * 0.46);
  add(new THREE.BoxGeometry(chassisWidth * 0.9, 0.05, 0.35), trimMat, 0, 0.38, -chassisLength * 0.46);

  parts.forEach((mesh) => group.add(mesh));
  return { group, bodyMat };
}

/**
 * Vehicle descriptor consumed by lib/vehicles/index.js's registry (and, via
 * that, lib/car.js's shared rig + the lobby's vehicle picker). `buildBody`
 * must return `{ group, bodyMat }`: a THREE.Group sized to roughly
 * chassisWidth x chassisLength, and the paintable shell material so a
 * remote car can recolor without rebuilding geometry.
 */
export default {
  id: 'gc8',
  name: 'Subaru Impreza GC8',
  category: 'cars',
  defaultColor: DEFAULT_BODY_COLOR,
  buildBody,
  // Baseline rally car engine rating (equivalent bhp - see lib/car.js's
  // hpToEngineForce), independent of every other vehicle's own rating.
  enginePowerHp: 300,
  // Chassis weight in kg (read generically by lib/car.js's createCar) -
  // the baseline rally car's own independent weight rating.
  mass: 150,
  // See lib/airDrag.js - a real, tapered car nose cuts through the air
  // more easily than its flat-ish tail (plus the roof spoiler kicking up
  // a bit more turbulence reversing into the air), and its flank is by
  // far the biggest cross-section of all three.
  dragProfile: { front: 0.85, side: 2.4, rear: 1.2 },
};
