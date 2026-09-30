// A short, fast bullet fired from the local car. It is a dynamic sphere so
// it can strike the kinematic stand-ins of other players (group 8), plus
// buildings and the ground. It does not collide with the shooter's own
// chassis. The first contact ends the shot; a car contact scores once.
// Everyone else only draws the same flight from the shot message.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GROUND_COLLISION_GROUP } from './terrain.js';
import { BUILDING_COLLISION_GROUP } from './buildings.js';
import { BULLET_COLLISION_GROUP, REMOTE_CAR_GROUP } from './remoteCollisions.js';

const SPEED = 90;
const SPAWN_AHEAD = 3.2;
const LIFE_S = 1.1;
const COOLDOWN_MS = 400;
const RADIUS = 0.18;

const FORWARD = new CANNON.Vec3(0, 0, 1);
const BULLET_GEO = new THREE.SphereGeometry(RADIUS, 8, 6);
const BULLET_MAT = new THREE.MeshBasicMaterial({ color: 0xffe14a });

export function createShots({ scene, world, onCarHit }) {
  const live = [];
  let nextFire = 0;

  function makeMesh() {
    const mesh = new THREE.Mesh(BULLET_GEO, BULLET_MAT);
    scene.add(mesh);
    return mesh;
  }

  function removeAt(index) {
    const shot = live[index];
    if (shot.body) world.removeBody(shot.body);
    scene.remove(shot.mesh);
    live.splice(index, 1);
  }

  function tryFire(chassisBody, held) {
    if (!held || !chassisBody) return null;
    const now = performance.now();
    if (now < nextFire) return null;
    nextFire = now + COOLDOWN_MS;

    const forward = new CANNON.Vec3();
    chassisBody.quaternion.vmult(FORWARD, forward);
    const pos = chassisBody.position;
    const x = pos.x + forward.x * SPAWN_AHEAD;
    const y = pos.y + 0.35;
    const z = pos.z + forward.z * SPAWN_AHEAD;
    const vx = forward.x * SPEED;
    const vy = 0;
    const vz = forward.z * SPEED;

    const body = new CANNON.Body({
      mass: 1,
      collisionFilterGroup: BULLET_COLLISION_GROUP,
      collisionFilterMask: REMOTE_CAR_GROUP | BUILDING_COLLISION_GROUP | GROUND_COLLISION_GROUP,
      linearDamping: 0,
      angularDamping: 1,
    });
    body.addShape(new CANNON.Sphere(RADIUS));
    body.position.set(x, y, z);
    body.velocity.set(vx, vy, vz);
    const shot = { body, mesh: makeMesh(), age: 0, hit: false, hitId: null, remote: false };
    shot.mesh.position.set(x, y, z);
    body.addEventListener('collide', (event) => {
      shot.hit = true;
      if (!shot.hitId && event.body?.playerId) shot.hitId = event.body.playerId;
    });
    world.addBody(body);
    live.push(shot);
    return { x, y, z, vx, vy, vz };
  }

  function spawnRemote(msg) {
    if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y) || !Number.isFinite(msg.z)) return;
    if (!Number.isFinite(msg.vx) || !Number.isFinite(msg.vy) || !Number.isFinite(msg.vz)) return;
    const mesh = makeMesh();
    mesh.position.set(msg.x, msg.y, msg.z);
    live.push({
      body: null,
      mesh,
      age: 0,
      hit: false,
      hitId: null,
      remote: true,
      vx: msg.vx,
      vy: msg.vy,
      vz: msg.vz,
    });
  }

  // Called after each physics step. A hit removes the bullet before the
  // next step, and wiping vertical speed keeps gravity from dropping the
  // shot into the road over its short life.
  function flushHits() {
    for (let i = live.length - 1; i >= 0; i--) {
      const shot = live[i];
      if (!shot.body) continue;
      shot.body.velocity.y = 0;
      if (!shot.hit) continue;
      if (shot.hitId) onCarHit?.(shot.hitId);
      removeAt(i);
    }
  }

  function update(dt) {
    for (let i = live.length - 1; i >= 0; i--) {
      const shot = live[i];
      shot.age += dt;
      if (shot.remote) {
        shot.mesh.position.x += shot.vx * dt;
        shot.mesh.position.y += shot.vy * dt;
        shot.mesh.position.z += shot.vz * dt;
      } else if (shot.body) {
        shot.mesh.position.copy(shot.body.position);
      }
      if (shot.age > LIFE_S) removeAt(i);
    }
  }

  return { tryFire, spawnRemote, flushHits, update };
}
