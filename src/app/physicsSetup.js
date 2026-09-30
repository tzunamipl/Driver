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
  // Bounce on any collision (ground, buildings, etc.) instead of the
  // default perfectly inelastic (restitution 0) impact - keeps hard hits
  // from feeling like the car just instantly stops/sticks.
  world.defaultContactMaterial.restitution = 0.3;

  // Chassis-vs-building contact tuned separately from the world default:
  // near-zero friction and a strong bounce, so scraping a wall at a
  // shallow/grazing angle slides the car along the surface (and rebounds
  // off it) instead of the low-but-nonzero default friction "catching" the
  // contact and killing the car's tangential speed on impact. (Also: this
  // pairing only takes effect now that building bodies are actually
  // tagged with BUILDING_MATERIAL - see buildings.js - previously they had
  // no material at all and silently used the world default above instead.)
  world.addContactMaterial(
    new CANNON.ContactMaterial(CHASSIS_MATERIAL, BUILDING_MATERIAL, {
      friction: 0.01,
      restitution: 0.6,
    })
  );

  return world;
}
