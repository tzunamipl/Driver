// Knock-over physics for light props (roadside.js, rally control scenery): a static trigger
// the local chassis passes through (no collision response, wheel rays skip it), swapped on
// contact for a tumbling body thrown along the car's velocity. Once the body rests it goes
// and the mesh stays where it lies.

import * as CANNON from 'cannon-es';
import { GROUND_COLLISION_GROUP, GROUND_MATERIAL } from './terrain.js';
import { BUILDING_COLLISION_GROUP, BUILDING_MATERIAL } from './buildings.js';

export const KNOCKABLE_COLLISION_GROUP = 64;
const LOCAL_CHASSIS_GROUP = 1;
const DEBRIS_SPEED_FACTOR = 1.15; // of the car's velocity, so it flies clear ahead
const DEBRIS_UP_SPEED = 2.5;
const DEBRIS_SIDE_SPEED = 2; // away from the car's centreline
const DEBRIS_SPIN = 8; // rad/s
const DEBRIS_REST_SPEED = 0.3; // m/s
const DEBRIS_REST_S = 1;
// Still moving after this (fell through the ground or off the physics tiles): hidden and dropped.
const DEBRIS_MAX_S = 30;
const DEBRIS_MATERIAL = new CANNON.Material('roadside');
const worldsWithMaterials = new WeakSet();

function addContactMaterials(world) {
  if (worldsWithMaterials.has(world)) return;
  worldsWithMaterials.add(world);
  // The world default friction is near zero; without these an object slides for hundreds of metres.
  world.addContactMaterial(new CANNON.ContactMaterial(DEBRIS_MATERIAL, GROUND_MATERIAL, { friction: 0.6, restitution: 0.2 }));
  world.addContactMaterial(new CANNON.ContactMaterial(DEBRIS_MATERIAL, BUILDING_MATERIAL, { friction: 0.4, restitution: 0.3 }));
}

/** Static trigger body (not yet in the world); `onHit(by)` fires during the physics step. */
export function createTrigger(shape, onHit, offset) {
  const body = new CANNON.Body({
    mass: 0,
    type: CANNON.Body.STATIC,
    collisionResponse: false,
    collisionFilterGroup: KNOCKABLE_COLLISION_GROUP,
    collisionFilterMask: LOCAL_CHASSIS_GROUP,
  });
  body.addShape(shape, offset);
  body.addEventListener('collide', (event) => onHit(event.body));
  return body;
}

/**
 * Tumbling body at (position, quaternion) thrown along `by`'s velocity, added to the world.
 * @param {{mass: number, debrisSpheres: number[][], debrisRadius: number}} spec - sphere offsets from the body centre.
 */
export function launchDebris(world, spec, position, quaternion, by) {
  addContactMaterials(world);
  const body = new CANNON.Body({
    mass: spec.mass,
    material: DEBRIS_MATERIAL,
    linearDamping: 0.1,
    angularDamping: 0.3,
    collisionFilterGroup: KNOCKABLE_COLLISION_GROUP,
    collisionFilterMask: GROUND_COLLISION_GROUP | BUILDING_COLLISION_GROUP,
  });
  // Spheres, since boxes snag on the heightfield.
  for (const [sx, sy, sz] of spec.debrisSpheres) {
    body.addShape(new CANNON.Sphere(spec.debrisRadius), new CANNON.Vec3(sx, sy, sz));
  }
  body.position.copy(position);
  body.quaternion.copy(quaternion);
  const v = by.velocity;
  let sx = position.x - by.position.x;
  let sz = position.z - by.position.z;
  const side = Math.hypot(sx, sz) || 1;
  sx /= side;
  sz /= side;
  body.velocity.set(
    v.x * DEBRIS_SPEED_FACTOR + sx * DEBRIS_SIDE_SPEED,
    Math.max(0, v.y) + DEBRIS_UP_SPEED,
    v.z * DEBRIS_SPEED_FACTOR + sz * DEBRIS_SIDE_SPEED
  );
  // Topple about the horizontal axis across the car's travel.
  const speed = Math.hypot(v.x, v.z) || 1;
  body.angularVelocity.set((v.z / speed) * DEBRIS_SPIN, (Math.random() - 0.5) * DEBRIS_SPIN, (-v.x / speed) * DEBRIS_SPIN);
  world.addBody(body);
  return body;
}

/** Per frame: `debris` { mesh, body, age, restAge } follows its body until it rests (body dropped, set to null). */
export function settleDebris(world, debris, dt) {
  const { mesh, body } = debris;
  if (!body) return;
  mesh.position.copy(body.position);
  mesh.quaternion.copy(body.quaternion);
  debris.age += dt;
  const resting = body.velocity.lengthSquared() < DEBRIS_REST_SPEED ** 2 && body.angularVelocity.lengthSquared() < 1;
  debris.restAge = resting ? debris.restAge + dt : 0;
  if (debris.restAge >= DEBRIS_REST_S || debris.age >= DEBRIS_MAX_S) {
    if (!resting) mesh.visible = false;
    world.removeBody(body);
    debris.body = null;
  }
}
