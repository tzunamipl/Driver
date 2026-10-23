import * as CANNON from 'cannon-es';
import { CHASSIS_MATERIAL } from '../lib/car.js';
import { BUILDING_MATERIAL } from '../lib/buildings.js';
import { GROUND_MATERIAL } from '../lib/terrain.js';
import { GRAVITY } from '../lib/physicsConstants.js';

// Physics world: gravity, broadphase and contact materials.

const isMover = (body) => (body.type & CANNON.Body.STATIC) === 0 && body.sleepState !== CANNON.Body.SLEEPING;

/**
 * Pairs only bodies that can move against everything else: O(movers * bodies).
 * cannon's SAP/Naive loops are O(bodies^2) here, since thousands of static
 * buildings/props never pair but are still walked against each other.
 */
class MoverBroadphase extends CANNON.NaiveBroadphase {
  collisionPairs(world, pairs1, pairs2) {
    const bodies = world.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      if (!isMover(a)) continue;
      for (let j = 0; j < bodies.length; j++) {
        const b = bodies[j];
        // Mover pairs once (from the lower index); static ones from the mover's side only.
        if (j === i || (j < i && isMover(b))) continue;
        if (this.needBroadphaseCollision(a, b)) this.intersectionTest(a, b, pairs1, pairs2);
      }
    }
  }
}

export function createPhysicsWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAVITY, 0) });
  world.broadphase = new MoverBroadphase();
  // The default matrix is dense (bodies^2 / 2) and zeroed every step; this one only holds touching pairs.
  world.collisionMatrix = new CANNON.ObjectCollisionMatrix();
  world.collisionMatrixPrevious = new CANNON.ObjectCollisionMatrix();
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
