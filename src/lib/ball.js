// A ball the room can bounce. The player who spawned it simulates a dynamic
// body and broadcasts the pose. Everyone else keeps a kinematic sphere in
// the local chassis group, so their car trims it, while the owner's dynamic
// ball also hits the kinematic stand-ins of other cars (those proxies only
// collide with group 1) and the broadcast carries the result.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { CHASSIS_MATERIAL } from './car.js';
import { GROUND_MATERIAL } from './terrain.js';
import { BUILDING_MATERIAL } from './buildings.js';

const BALL_RADIUS = 0.6;
const LOCAL_CHASSIS_GROUP = 1;

const BALL_MATERIAL = new CANNON.Material('ball');
const BALL_GEO = new THREE.SphereGeometry(BALL_RADIUS, 20, 14);
const BALL_MAT = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.4, metalness: 0.05 });

export function createBalls(scene, world) {
  world.addContactMaterial(
    new CANNON.ContactMaterial(BALL_MATERIAL, CHASSIS_MATERIAL, { friction: 0.25, restitution: 0.75 })
  );
  world.addContactMaterial(
    new CANNON.ContactMaterial(BALL_MATERIAL, GROUND_MATERIAL, { friction: 0.35, restitution: 0.65 })
  );
  world.addContactMaterial(
    new CANNON.ContactMaterial(BALL_MATERIAL, BUILDING_MATERIAL, { friction: 0.15, restitution: 0.55 })
  );

  const balls = new Map();
  let seq = 0;

  function makeMesh() {
    const mesh = new THREE.Mesh(BALL_GEO, BALL_MAT);
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  }

  function spawnOwned(chassisBody, clientId) {
    const forward = new CANNON.Vec3(0, 0, 1);
    chassisBody.quaternion.vmult(forward, forward);
    const id = `${clientId}:ball:${seq++}`;
    const x = chassisBody.position.x + forward.x * 6;
    const y = chassisBody.position.y + 1.6;
    const z = chassisBody.position.z + forward.z * 6;
    const body = new CANNON.Body({
      mass: 4,
      material: BALL_MATERIAL,
      linearDamping: 0.15,
      angularDamping: 0.2,
    });
    body.addShape(new CANNON.Sphere(BALL_RADIUS));
    body.position.set(x, y, z);
    world.addBody(body);
    const mesh = makeMesh();
    mesh.position.set(x, y, z);
    balls.set(id, { body, mesh, owned: true });
    return { ballId: id, x, y, z };
  }

  function ensureRemote(ballId, pose) {
    if (!ballId || !Number.isFinite(pose.x) || !Number.isFinite(pose.y) || !Number.isFinite(pose.z)) return;
    let ball = balls.get(ballId);
    if (ball?.owned) return;
    if (!ball) {
      const body = new CANNON.Body({
        mass: 4,
        type: CANNON.Body.KINEMATIC,
        material: BALL_MATERIAL,
        collisionFilterGroup: LOCAL_CHASSIS_GROUP,
        collisionFilterMask: LOCAL_CHASSIS_GROUP,
        allowSleep: false,
      });
      body.addShape(new CANNON.Sphere(BALL_RADIUS));
      world.addBody(body);
      ball = { body, mesh: makeMesh(), owned: false };
      balls.set(ballId, ball);
    }
    ball.body.position.set(pose.x, pose.y, pose.z);
    if (Number.isFinite(pose.qx)) ball.body.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
    if (Number.isFinite(pose.vx)) ball.body.velocity.set(pose.vx, pose.vy, pose.vz);
    ball.body.wakeUp();
  }

  function ownedPoses() {
    const poses = [];
    for (const [ballId, ball] of balls) {
      if (!ball.owned) continue;
      const body = ball.body;
      poses.push({
        ballId,
        x: body.position.x,
        y: body.position.y,
        z: body.position.z,
        qx: body.quaternion.x,
        qy: body.quaternion.y,
        qz: body.quaternion.z,
        qw: body.quaternion.w,
        vx: body.velocity.x,
        vy: body.velocity.y,
        vz: body.velocity.z,
      });
    }
    return poses;
  }

  function syncMeshes() {
    for (const ball of balls.values()) {
      ball.mesh.position.copy(ball.body.position);
      ball.mesh.quaternion.copy(ball.body.quaternion);
    }
  }

  return { spawnOwned, ensureRemote, ownedPoses, syncMeshes };
}
