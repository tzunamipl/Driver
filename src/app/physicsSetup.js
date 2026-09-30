import * as CANNON from 'cannon-es';
import { CHASSIS_MATERIAL } from '../lib/car.js';
import { BUILDING_MATERIAL } from '../lib/buildings.js';

// Physics world bootstrap: gravity, broadphase, and global/pairwise contact
// material tuning. Isolated so physics tuning (friction, restitution,
// bounce) can be iterated on without touching rendering or gameplay code.

export function createPhysicsWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.defaultContactMaterial.friction = 0.05;
  // Small amount of bounce on any collision (ground, buildings, etc.)
  // instead of the default perfectly inelastic (restitution 0) impact -
  // keeps hard hits from feeling like the car just instantly stops/sticks.
  world.defaultContactMaterial.restitution = 0.15;

  // Chassis-vs-building contact tuned separately from the world default:
  // near-zero friction and a stronger bounce, so scraping a wall at a
  // shallow/grazing angle slides the car along the surface (and rebounds
  // off it) instead of the low-but-nonzero default friction "catching" the
  // contact and killing the car's tangential speed on impact.
  world.addContactMaterial(
    new CANNON.ContactMaterial(CHASSIS_MATERIAL, BUILDING_MATERIAL, {
      friction: 0.01,
      restitution: 0.35,
    })
  );

  return world;
}
