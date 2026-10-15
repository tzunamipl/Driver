import * as CANNON from 'cannon-es';
import { CHASSIS_MATERIAL } from '../lib/car.js';
import { BUILDING_MATERIAL } from '../lib/buildings.js';
import { GROUND_MATERIAL } from '../lib/terrain.js';
import { GRAVITY } from '../lib/physicsConstants.js';

// Physics world: gravity, broadphase and contact materials.

export function createPhysicsWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAVITY, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.defaultContactMaterial.friction = 0.05;
  // Some bounce on every collision, so hard hits don't just stick.
  world.defaultContactMaterial.restitution = 0.3;

  // Chassis vs building: near-zero friction and bounce, so grazing a wall
  // slides along it instead of catching.
  world.addContactMaterial(
    new CANNON.ContactMaterial(CHASSIS_MATERIAL, BUILDING_MATERIAL, {
      friction: 0.01,
      restitution: 0.6,
    })
  );

  // Chassis vs ground: only a rollover/bottom-out safety net (wheels do the
  // driving), so firm and non-bouncy - a bouncy contact snowballed into
  // tumbles. cannon caps friction per contact at mu*m*g regardless of load,
  // and a sphere on a heightfield yields several contacts, so mu stays tiny.
  world.addContactMaterial(
    new CANNON.ContactMaterial(CHASSIS_MATERIAL, GROUND_MATERIAL, {
      friction: 0.02,
      restitution: 0,
    })
  );

  return world;
}
