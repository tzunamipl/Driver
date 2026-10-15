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

// Fraction of the body's height (from the bottom) that counts as lower body;
// everything above is cabin/greenhouse.
const BELT_FRACTION = 0.6;
const MAX_ROOF_SPHERE_RADIUS = 0.25;

/**
 * Collision layout fitted to the body mesh (chassis-local, built at the
 * origin): a lower-body box over the full bounds up to the belt, a cabin box
 * over whatever sits above mid-window height, and ground spheres rounding
 * the lower-body corners and the roof corners.
 */
export function fitChassisHitbox(mesh) {
  mesh.updateMatrixWorld(true);
  const points = [];
  mesh.traverse((obj) => {
    const position = obj.geometry?.attributes.position;
    if (!position) return;
    for (let i = 0; i < position.count; i++) {
      points.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(obj.matrixWorld));
    }
  });
  const { min, max } = new THREE.Box3().setFromPoints(points);
  const belt = min.y + (max.y - min.y) * BELT_FRACTION;

  const lowerBounds = new THREE.Box3().setFromPoints(points.filter((p) => p.y <= belt));
  const cabinBounds = new THREE.Box3().setFromPoints(points.filter((p) => p.y > (belt + max.y) / 2));
  const lowerHalfWidth = Math.max(-lowerBounds.min.x, lowerBounds.max.x);
  const cabinHalfWidth = Math.max(-cabinBounds.min.x, cabinBounds.max.x);

  const lower = {
    halfExtents: new CANNON.Vec3(lowerHalfWidth, (belt - min.y) / 2, (lowerBounds.max.z - lowerBounds.min.z) / 2),
    offset: new CANNON.Vec3(0, (belt + min.y) / 2, (lowerBounds.max.z + lowerBounds.min.z) / 2),
  };
  const cabin = {
    halfExtents: new CANNON.Vec3(cabinHalfWidth, (max.y - belt) / 2, (cabinBounds.max.z - cabinBounds.min.z) / 2),
    offset: new CANNON.Vec3(0, (max.y + belt) / 2, (cabinBounds.max.z + cabinBounds.min.z) / 2),
  };

  // Lower spheres span the whole lower-body height, so its edges are round.
  const lowerRadius = Math.min(lower.halfExtents.y, lower.halfExtents.x, lower.halfExtents.z);
  const roofRadius = Math.min(MAX_ROOF_SPHERE_RADIUS, cabin.halfExtents.y, cabin.halfExtents.x, cabin.halfExtents.z);
  const spheres = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      spheres.push({
        radius: lowerRadius,
        offset: new CANNON.Vec3(
          sx * (lower.halfExtents.x - lowerRadius),
          lower.offset.y,
          lower.offset.z + sz * (lower.halfExtents.z - lowerRadius)
        ),
      });
      spheres.push({
        radius: roofRadius,
        offset: new CANNON.Vec3(
          sx * (cabin.halfExtents.x - roofRadius),
          max.y - roofRadius,
          cabin.offset.z + sz * (cabin.halfExtents.z - roofRadius)
        ),
      });
    }
  }
  return { boxes: [lower, cabin], spheres };
}

/**
 * Compound chassis body from fitChassisHitbox(): the boxes handle
 * buildings/pedestrians (masked off the ground - box-vs-heightfield snags on
 * cell edges) and the spheres alone touch the ground, so scrapes and
 * rollovers slide smoothly.
 */
export function createChassisBody(mass, position, quaternion, hitbox) {
  const body = new CANNON.Body({ mass, material: CHASSIS_MATERIAL });
  for (const { halfExtents, offset } of hitbox.boxes) {
    const box = new CANNON.Box(halfExtents);
    box.collisionFilterMask = ~GROUND_COLLISION_GROUP;
    body.addShape(box, offset);
  }
  for (const { radius, offset } of hitbox.spheres) {
    const sphere = new CANNON.Sphere(radius);
    sphere.collisionFilterMask = GROUND_COLLISION_GROUP;
    body.addShape(sphere, offset);
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

/** Debug wireframes of the hitbox boxes + spheres, parented to `parent`. */
export function buildChassisHitboxMeshes(parent, hitbox) {
  const material = createHitboxMaterial();
  const meshes = [];
  for (const { halfExtents: h, offset } of hitbox.boxes) {
    const box = hitboxMesh(new THREE.BoxGeometry(2 * h.x, 2 * h.y, 2 * h.z), material);
    box.position.copy(offset);
    meshes.push(box);
  }
  for (const { radius, offset } of hitbox.spheres) {
    const sphere = hitboxMesh(new THREE.SphereGeometry(radius, 8, 6), material);
    sphere.position.copy(offset);
    meshes.push(sphere);
  }
  for (const m of meshes) parent.add(m);
  return meshes;
}
