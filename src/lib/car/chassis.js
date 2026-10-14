// Wheeled-car chassis: collision body, inertia fix-up and debug hitbox meshes.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CHASSIS_MATERIAL, createHitboxMaterial, hitboxMesh } from '../vehicleShared.js';
import { GROUND_COLLISION_GROUP } from '../terrain.js';

export const CHASSIS_WIDTH = 1.8;
export const CHASSIS_HEIGHT = 0.6;
export const CHASSIS_LENGTH = 4;
export const AXLE_HALF_WIDTH = CHASSIS_WIDTH / 2 - 0.1;
export const WHEEL_FRONT_Z = 1.3;
export const WHEEL_BACK_Z = -1.3;

/**
 * Top-down footprint: octagon tapered at nose and tail, convex (required by
 * ConvexPolyhedron). Winding gives outward face normals in buildHullPrism.
 */
function buildHullPoints(width, length) {
  const w = width / 2;
  const l = length / 2;
  return [
    { x: -0.5 * w, z: l },
    { x: -w, z: 0.55 * l },
    { x: -w, z: -0.55 * l },
    { x: -0.5 * w, z: -l },
    { x: 0.5 * w, z: -l },
    { x: w, z: -0.55 * l },
    { x: w, z: 0.55 * l },
    { x: 0.5 * w, z: l },
  ];
}

/** Vertical prism over `hull`, spanning ±halfHeight around the body origin. */
function buildHullPrism(hull, halfHeight) {
  const n = hull.length;
  const vertices = [];
  const sideFaces = [];
  const bottomFace = [];
  const topFace = [];
  for (let i = 0; i < n; i++) {
    const p = hull[i];
    vertices.push(new CANNON.Vec3(p.x, -halfHeight, p.z));
    bottomFace.push(2 * i);
    vertices.push(new CANNON.Vec3(p.x, halfHeight, p.z));
    topFace.push(2 * i + 1);
    const j = (i + 1) % n;
    sideFaces.push([2 * i, 2 * i + 1, 2 * j + 1, 2 * j]);
  }
  const faces = [...sideFaces, bottomFace, topFace.slice().reverse()];
  return new CANNON.ConvexPolyhedron({ vertices, faces });
}

const HITBOX_RADIUS = Math.min(CHASSIS_WIDTH, CHASSIS_HEIGHT) / 2 - 0.05;

/** Local offsets of the 8 corner spheres. */
function cornerOffsets() {
  const out = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        out.push([
          sx * (CHASSIS_WIDTH / 2 - HITBOX_RADIUS),
          sy * (CHASSIS_HEIGHT / 2 - HITBOX_RADIUS),
          sz * (CHASSIS_LENGTH / 2 - HITBOX_RADIUS),
        ]);
      }
    }
  }
  return out;
}

/**
 * Compound chassis body: the car-shaped hull handles buildings/pedestrians
 * (masked off the ground, so a low hull can't snag on road beds) and 8
 * corner spheres catch the ground on rollovers.
 */
export function createChassisBody(mass, position, quaternion) {
  const body = new CANNON.Body({ mass, material: CHASSIS_MATERIAL });
  const hull = buildHullPrism(buildHullPoints(CHASSIS_WIDTH, CHASSIS_LENGTH), CHASSIS_HEIGHT / 2);
  hull.collisionFilterMask = ~GROUND_COLLISION_GROUP;
  body.addShape(hull);
  for (const [x, y, z] of cornerOffsets()) {
    body.addShape(new CANNON.Sphere(HITBOX_RADIUS), new CANNON.Vec3(x, y, z));
  }
  body.position.copy(position);
  body.quaternion.copy(quaternion);
  body.angularVelocity.set(0, 0, 0);
  return body;
}

/**
 * cannon-es derives inertia from the shapes' thin AABB, which made the car
 * flip end-over-end easily. Recompute it from the real footprint (track x
 * ground drop x wheelbase) so pitch/roll resist like a real car.
 */
export function applyFootprintInertia(body, halfExtents) {
  CANNON.Box.calculateInertia(halfExtents, body.mass, body.inertia);
  body.invInertia.set(
    body.inertia.x > 0 ? 1 / body.inertia.x : 0,
    body.inertia.y > 0 ? 1 / body.inertia.y : 0,
    body.inertia.z > 0 ? 1 / body.inertia.z : 0
  );
  body.updateInertiaWorld(true);
}

/** Debug wireframes of the hull + corner spheres, parented to `parent`. */
export function buildChassisHitboxMeshes(parent) {
  const material = createHitboxMaterial();
  const shape = new THREE.Shape();
  buildHullPoints(CHASSIS_WIDTH, CHASSIS_LENGTH).forEach((p, i) => {
    if (i === 0) shape.moveTo(p.x, -p.z);
    else shape.lineTo(p.x, -p.z);
  });
  const hullGeometry = new THREE.ExtrudeGeometry(shape, { depth: CHASSIS_HEIGHT, bevelEnabled: false, curveSegments: 1 });
  hullGeometry.rotateX(-Math.PI / 2);
  hullGeometry.translate(0, -CHASSIS_HEIGHT / 2, 0);

  const meshes = [hitboxMesh(hullGeometry, material)];
  for (const [x, y, z] of cornerOffsets()) {
    const sphere = hitboxMesh(new THREE.SphereGeometry(HITBOX_RADIUS, 8, 6), material);
    sphere.position.set(x, y, z);
    meshes.push(sphere);
  }
  for (const m of meshes) parent.add(m);
  return meshes;
}
