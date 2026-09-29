// Kinematic stand-ins for other players' cars. Each client still simulates
// only its own RaycastVehicle; everyone else is a moving obstacle that the
// local chassis can bump. The other client has the mirror image, so both
// drivers feel the hit and the next pose broadcast carries the result.
//
// Group 8 is free (ground is 2, buildings are 4, the local chassis stays
// on the default group 1). The mask is group 1 only, so a proxy never
// touches the terrain trimesh, buildings, or the other proxies.

import * as CANNON from 'cannon-es';
import { CHASSIS_MATERIAL } from './car.js';

// Same outer size as the local chassis. A box, not the local car's eight
// corner spheres: those leave a gap down the middle, and a head-on hit
// slips through. Sphere-vs-box is implemented; the box never touches the
// terrain trimesh because of the mask above.
const CHASSIS_WIDTH = 1.8;
const CHASSIS_HEIGHT = 0.6;
const CHASSIS_LENGTH = 4;

const REMOTE_CAR_GROUP = 8;
const LOCAL_CHASSIS_GROUP = 1;

// Replicated speed is along the car's nose (+Z). Cap it so a bad packet
// can't turn the proxy into a projectile the local car then collides with.
const MAX_SPEED = 60;
const FORWARD = new CANNON.Vec3(0, 0, 1);

export function createRemoteCollisions(world) {
  world.addContactMaterial(
    new CANNON.ContactMaterial(CHASSIS_MATERIAL, CHASSIS_MATERIAL, {
      friction: 0.2,
      restitution: 0.1,
    })
  );

  const bodies = new Map();

  function sync(poses) {
    const seen = new Set();
    for (const pose of poses) {
      seen.add(pose.id);
      let body = bodies.get(pose.id);
      if (!body) {
        body = createProxyBody();
        world.addBody(body);
        bodies.set(pose.id, body);
      }
      placeBody(body, pose);
    }
    for (const [id, body] of bodies) {
      if (seen.has(id)) continue;
      world.removeBody(body);
      bodies.delete(id);
    }
  }

  return { sync };
}

function createProxyBody() {
  const body = new CANNON.Body({
    mass: 150,
    type: CANNON.Body.KINEMATIC,
    material: CHASSIS_MATERIAL,
    collisionFilterGroup: REMOTE_CAR_GROUP,
    collisionFilterMask: LOCAL_CHASSIS_GROUP,
    allowSleep: false,
  });
  body.addShape(new CANNON.Box(new CANNON.Vec3(CHASSIS_WIDTH / 2, CHASSIS_HEIGHT / 2, CHASSIS_LENGTH / 2)));
  return body;
}

function placeBody(body, pose) {
  body.position.set(pose.x, pose.y, pose.z);
  body.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
  const speed = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, Number.isFinite(pose.speed) ? pose.speed : 0));
  body.quaternion.vmult(FORWARD, body.velocity);
  body.velocity.scale(speed, body.velocity);
  body.angularVelocity.set(0, 0, 0);
  body.wakeUp();
}
