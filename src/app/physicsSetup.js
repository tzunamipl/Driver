import * as CANNON from 'cannon-es';
import { CHASSIS_MATERIAL } from '../lib/car.js';
import { BUILDING_MATERIAL } from '../lib/buildings.js';
import { GROUND_MATERIAL } from '../lib/terrain.js';
import { GRAVITY } from '../lib/physicsConstants.js';

// Physics world bootstrap: gravity, broadphase, and global/pairwise contact
// material tuning. Isolated so physics tuning (friction, restitution,
// bounce) can be iterated on without touching rendering or gameplay code.

export function createPhysicsWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -GRAVITY, 0) });
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

  // Chassis-vs-ground tuned separately too, in the opposite direction from
  // buildings: the RaycastVehicle's wheels (not real collision shapes)
  // already do all of the actual driving traction, so the chassis' own
  // collision shapes (the tapered hull + 8 corner hitbox spheres - see
  // car.js) only ever touch the terrain as a rollover/scrape safety net,
  // e.g. suspension bottoming out under hard acceleration squat, or the
  // car resting on its roof/side. Left on the world default (0.3
  // restitution, near-zero 0.05 friction - tuned instead for buildings'
  // glancing-hit slides), that safety-net contact behaves like a
  // low-grip trampoline: every bottom-out bounces the chassis back up
  // with almost nothing to damp any sideways/angular component, which
  // easily snowballs into a tumble under exactly the harder acceleration
  // that causes more squat in the first place. A firm, non-bouncy contact
  // here makes that safety net behave like it's actually resting/scraping
  // on the ground instead of launching off it. Friction lowered from an
  // earlier 0.3 so a rollover/belly-scrape slides smoothly across the
  // terrain instead of catching and tumbling/jerking to a stop.
  world.addContactMaterial(
    new CANNON.ContactMaterial(CHASSIS_MATERIAL, GROUND_MATERIAL, {
      friction: 0.1,
      restitution: 0,
    })
  );

  return world;
}
