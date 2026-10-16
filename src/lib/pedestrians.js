// Yellow low-poly figures scattered on a fixed grid around the driver. The
// cell hash is the same for every client, so a friend on the same street
// meets the same figure. While standing, the body is a trigger: the car
// drives through it and cannon-es still emits collide. The first driver to
// hit one scores. The figure then becomes a dynamic body, pushed out of the
// car's body boxes and thrown off the face that hit it, so it tumbles and
// bounces instead of vanishing. It keeps colliding with the car's body boxes
// (bonnet, cabin, trailer), but not the ground-only corner spheres or the
// wheel hitboxes. Ground and walls bounce it too. A hit id is remembered and is not
// placed again. Other clients play the same throw from the hit message and
// do not score.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GROUND_MATERIAL } from './terrain.js';
import { BUILDING_COLLISION_GROUP, BUILDING_MATERIAL } from './buildings.js';

const PED_GROUP = 16;
const LOCAL_CHASSIS_GROUP = 1;
const WHEEL_HITBOX_SHAPE_GROUP = 32; // car.js wheel spheres; ragdolls ignore them
// One candidate every 90 m, and every cell grows a figure, so a few
// hundred metres of loaded streets hold about four dozen of them. The
// cell hash still picks the spot inside the cell, so figures that were
// already there stay put.
const CELL_M = 90;
const SPAWN_RADIUS_M = 320;
const DESPAWN_RADIUS_M = 480;
const SCAN_INTERVAL_MS = 500;
// Body origin sits at the chest. The mesh is built with its origin at the
// feet, so rendering shifts down by this much in the body's local frame.
const COM_Y = 0.75;
const RAGDOLL_SECONDS = 8;
// Ragdoll spheres as [y offset from the chest, radius].
const RAGDOLL_SPHERES = [[-0.5, 0.22], [0, 0.28], [0.42, 0.2]];
// Box-local directions a fresh ragdoll may be pushed out along (never down).
const PUSH_DIRS = [['x', 1], ['x', -1], ['y', 1], ['z', 1], ['z', -1]];
const PUSH_SKIN_M = 0.02;
const PED_RESTITUTION = 0.25;
const TANGENT_DRAG = 0.4; // share of the car's sliding velocity the figure picks up
const MAX_SEPARATION_SPEED = 8; // m/s faster than the car along the face normal
// Near-miss gasp: the own car passed a standing figure this fast, its centre
// within NEAR_MISS_M; the gasp comes once the car is moving away again.
const NEAR_MISS_MIN_SPEED = 8;
const NEAR_MISS_M = 4;
const BOUNCE_COOLDOWN_MS = 120;

const YELLOW = new THREE.MeshStandardMaterial({ color: 0xf1c40f, roughness: 0.55 });
const INK = new THREE.MeshStandardMaterial({ color: 0x2a2114, roughness: 0.8 });
const PED_MATERIAL = new CANNON.Material('ped');

const HEAD_GEO = new THREE.SphereGeometry(0.28, 10, 8);
const BODY_GEO = new THREE.BoxGeometry(0.42, 0.42, 0.26);
const ARM_GEO = new THREE.BoxGeometry(0.14, 0.28, 0.14);
const LEG_GEO = new THREE.BoxGeometry(0.14, 0.3, 0.14);

const feetOffset = new THREE.Vector3();

/**
 * `frame` ({ toNetwork, fromNetwork }, see app/viewFrame.js) keeps the cell
 * grid in the shared network frame, whatever this player's view frame is.
 */
export function createPedestrians(scene, world, groundGroup, frame = null) {
  world.addContactMaterial(
    new CANNON.ContactMaterial(PED_MATERIAL, GROUND_MATERIAL, { friction: 0.85, restitution: 0.22 })
  );
  world.addContactMaterial(
    new CANNON.ContactMaterial(PED_MATERIAL, BUILDING_MATERIAL, { friction: 0.45, restitution: 0.35 })
  );

  const peds = new Map();
  const killed = new Set();
  const pendingHits = [];
  let onHit = () => {};
  // Sound events: onHit(id, speed), onBounce(id, speed, position), onNearMiss(id, position).
  let sounds = {};
  let nextScan = 0;
  let carBodies = [];

  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const rayResult = new CANNON.RaycastResult();

  function groundY(x, z, aroundY) {
    const y = aroundY ?? 0;
    rayFrom.set(x, y + 200, z);
    rayTo.set(x, y - 200, z);
    rayResult.reset();
    world.raycastClosest(rayFrom, rayTo, { collisionFilterMask: groundGroup }, rayResult);
    return rayResult.hasHit ? rayResult.hitPointWorld.y : null;
  }

  function addPed(id, x, y, z) {
    if (!id || peds.has(id) || killed.has(id)) return;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const mesh = buildPed();
    mesh.position.set(x, y, z);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    scene.add(mesh);

    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.STATIC,
      collisionResponse: false,
      collisionFilterGroup: PED_GROUP,
      collisionFilterMask: LOCAL_CHASSIS_GROUP,
    });
    body.addShape(new CANNON.Sphere(0.45), new CANNON.Vec3(0, 0.7, 0));
    body.position.set(x, y, z);
    body.pedId = id;
    world.addBody(body);
    peds.set(id, { id, mesh, body, knocked: false, closeCall: false, gasped: false, age: 0, homeY: y });
  }

  function removePed(id) {
    const ped = peds.get(id);
    if (!ped) return false;
    world.removeBody(ped.body);
    scene.remove(ped.mesh);
    ped.mesh.traverse((obj) => {
      if (obj.geometry && !SHARED_GEOS.has(obj.geometry)) obj.geometry.dispose();
    });
    peds.delete(id);
    return true;
  }

  function bindChassis(chassisBody, extraBodies = []) {
    // Dynamic ones only: the kinematic wheel hitboxes don't throw ragdolls.
    carBodies = [chassisBody, ...extraBodies.filter((b) => b.type === CANNON.Body.DYNAMIC)];
    const onCollide = (event) => {
      const id = event.body?.pedId;
      const ped = id && peds.get(id);
      if (!ped || ped.knocked || killed.has(id)) return;
      if (pendingHits.some((hit) => hit.id === id)) return;
      // Always read velocity off the chassis itself, even when the hit
      // came from one of `extraBodies` (e.g. a wheel hitbox - see
      // lib/car.js) - those are kinematic and re-positioned by hand every
      // step rather than integrated by cannon, so they have no velocity
      // of their own to throw the pedestrian with.
      const velocity = chassisBody.velocity;
      pendingHits.push({ id, vx: velocity.x, vy: velocity.y, vz: velocity.z });
    };
    chassisBody.addEventListener('collide', onCollide);
    for (const body of extraBodies) body.addEventListener('collide', onCollide);
  }

  // Swap the trigger for a body the ground can actually hit. Spheres,
  // because cannon-es does not collide a box with the terrain trimesh.
  function knock(ped, vel, mine = false) {
    const mesh = ped.mesh;
    world.removeBody(ped.body);
    const body = new CANNON.Body({
      mass: 55,
      material: PED_MATERIAL,
      linearDamping: 0.08,
      angularDamping: 0.28,
      collisionFilterGroup: PED_GROUP,
      collisionFilterMask: groundGroup | BUILDING_COLLISION_GROUP | LOCAL_CHASSIS_GROUP,
    });
    for (const [y, radius] of RAGDOLL_SPHERES) {
      const sphere = new CANNON.Sphere(radius);
      // Shape group outside the chassis spheres' ground-only mask; wheel hitboxes skipped.
      sphere.collisionFilterGroup = PED_GROUP;
      sphere.collisionFilterMask = ~WHEEL_HITBOX_SHAPE_GROUP;
      body.addShape(sphere, new CANNON.Vec3(0, y, 0));
    }
    body.position.set(mesh.position.x, mesh.position.y + COM_Y, mesh.position.z);
    body.quaternion.set(mesh.quaternion.x, mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w);
    // Starting inside the car would make the penetration solver fire it off.
    const normal = pushOutOfCar(body);
    if (mine) launchOffCar(body, vel, normal ?? awayFromCar(body));
    else applyLaunch(body, vel);
    // Only figures this player hit make bounce sounds; remote throws stay quiet.
    if (mine) {
      let lastBounce = 0;
      body.addEventListener('collide', (event) => {
        const now = performance.now();
        if (now - lastBounce < BOUNCE_COOLDOWN_MS) return;
        lastBounce = now;
        const speed = Math.abs(event.contact.getImpactVelocityAlongNormal());
        sounds.onBounce?.(ped.id, speed, body.position);
      });
    }
    world.addBody(body);
    ped.body = body;
    ped.knocked = true;
    ped.age = 0;
    ped.homeY = body.position.y;
  }

  /** Moves a fresh ragdoll out of every car body box it overlaps; returns the last push direction (world) or null. */
  function pushOutOfCar(body) {
    let normal = null;
    for (const car of carBodies) {
      car.shapes.forEach((shape, i) => {
        if (shape.type !== CANNON.Shape.types.BOX || !(shape.collisionFilterMask & PED_GROUP)) return;
        const orientation = car.quaternion.mult(car.shapeOrientations[i]);
        const center = car.position.vadd(car.quaternion.vmult(car.shapeOffsets[i]));
        const toLocal = orientation.conjugate();
        const h = shape.halfExtents;
        const spheres = RAGDOLL_SPHERES.map(([y, r]) => ({
          r,
          local: toLocal.vmult(new CANNON.Vec3(body.position.x, body.position.y + y, body.position.z).vsub(center)),
        })).filter(({ r, local }) =>
          Math.abs(local.x) < h.x + r && Math.abs(local.y) < h.y + r && Math.abs(local.z) < h.z + r);
        if (!spheres.length) return;
        // Shortest way out through one face.
        let best = null;
        for (const [axis, sign] of PUSH_DIRS) {
          const push = Math.max(...spheres.map(({ r, local }) => h[axis] + r - sign * local[axis]));
          if (!best || push < best.push) best = { axis, sign, push };
        }
        const dirLocal = new CANNON.Vec3();
        dirLocal[best.axis] = best.sign;
        normal = orientation.vmult(dirLocal);
        body.position.vadd(normal.scale(best.push + PUSH_SKIN_M), body.position);
      });
    }
    return normal;
  }

  /** Fallback normal (clipped by a wheel, not a box): level, from the car's centre to the figure. */
  function awayFromCar(body) {
    const car = carBodies[0];
    const n = car ? new CANNON.Vec3(body.position.x - car.position.x, 0, body.position.z - car.position.z) : new CANNON.Vec3();
    if (n.length() < 1e-3) return new CANNON.Vec3(1, 0, 0);
    n.normalize();
    return n;
  }

  function flushHits() {
    if (!pendingHits.length) return;
    const hits = pendingHits.splice(0);
    for (const hit of hits) {
      const ped = peds.get(hit.id);
      if (!ped || ped.knocked || killed.has(hit.id)) continue;
      knock(ped, hit, true);
      killed.add(hit.id);
      onHit(hit.id, hit);
      sounds.onHit?.(hit.id, Math.hypot(hit.vx, hit.vy, hit.vz));
    }
  }

  // Another driver already scored this one. Topple the local copy if it is
  // loaded, and never spawn it standing again.
  function knockFromRemote(id, vel) {
    if (!id) return;
    killed.add(id);
    const ped = peds.get(id);
    if (!ped || ped.knocked) return;
    knock(ped, vel);
  }

  function syncMeshes(dt) {
    const doomed = [];
    for (const [id, ped] of peds) {
      if (!ped.knocked) continue;
      ped.age += dt;
      const body = ped.body;
      ped.mesh.quaternion.copy(body.quaternion);
      feetOffset.set(0, -COM_Y, 0).applyQuaternion(ped.mesh.quaternion);
      ped.mesh.position.copy(body.position).add(feetOffset);
      if (ped.age > RAGDOLL_SECONDS || body.position.y < ped.homeY - 25) doomed.push(id);
    }
    for (const id of doomed) removePed(id);
  }

  /** Standing figures gasp once after the own car (position x/z, velocity vx/vz) whizzes past them. */
  function updateNearMisses(x, z, vx, vz) {
    const fast = vx * vx + vz * vz >= NEAR_MISS_MIN_SPEED * NEAR_MISS_MIN_SPEED;
    for (const ped of peds.values()) {
      if (ped.knocked || ped.gasped) continue;
      const dx = ped.mesh.position.x - x;
      const dz = ped.mesh.position.z - z;
      if (fast && dx * dx + dz * dz < NEAR_MISS_M * NEAR_MISS_M) ped.closeCall = true;
      // Wait until the car is past (moving away), so a figure about to be hit stays quiet.
      if (!ped.closeCall || dx * vx + dz * vz > -1) continue;
      ped.gasped = true;
      sounds.onNearMiss?.(ped.id, ped.mesh.position);
    }
  }

  // Fill the streets around the car. Far figures are dropped locally so the
  // world doesn't grow without bound; driving back recreates any that were
  // not run over.
  function updatePopulation(x, y, z) {
    const now = performance.now();
    if (now < nextScan) return;
    nextScan = now + SCAN_INTERVAL_MS;

    const spawnR2 = SPAWN_RADIUS_M * SPAWN_RADIUS_M;
    const net = frame ? frame.toNetwork(x, z) : { x, z };
    const minIx = Math.floor((net.x - SPAWN_RADIUS_M) / CELL_M);
    const maxIx = Math.floor((net.x + SPAWN_RADIUS_M) / CELL_M);
    const minIz = Math.floor((net.z - SPAWN_RADIUS_M) / CELL_M);
    const maxIz = Math.floor((net.z + SPAWN_RADIUS_M) / CELL_M);
    for (let ix = minIx; ix <= maxIx; ix++) {
      for (let iz = minIz; iz <= maxIz; iz++) {
        const id = `ped:${ix}:${iz}`;
        if (killed.has(id) || peds.has(id) || !cellHasPed(ix, iz)) continue;
        const netPoint = pointInCell(ix, iz);
        const point = frame ? frame.fromNetwork(netPoint.x, netPoint.z) : netPoint;
        const dx = point.x - x;
        const dz = point.z - z;
        if (dx * dx + dz * dz > spawnR2) continue;
        const ground = groundY(point.x, point.z, y);
        if (ground == null) continue;
        addPed(id, point.x, ground, point.z);
      }
    }

    const despawnR2 = DESPAWN_RADIUS_M * DESPAWN_RADIUS_M;
    for (const [id, ped] of peds) {
      const dx = ped.body.position.x - x;
      const dz = ped.body.position.z - z;
      if (dx * dx + dz * dz > despawnR2) removePed(id);
    }
  }

  return {
    addPed,
    removePed,
    knockFromRemote,
    bindChassis,
    flushHits,
    syncMeshes,
    updatePopulation,
    updateNearMisses,
    getCount: () => peds.size,
    setOnHit(fn) {
      onHit = fn;
    },
    setSoundCallbacks(callbacks) {
      sounds = callbacks;
    },
  };
}

/**
 * Throw off the car face with outward `normal`: the car's velocity into that
 * face (plus restitution) along it, some of its sliding velocity, a hop and a tumble.
 */
function launchOffCar(body, vel, normal) {
  const carVel = new CANNON.Vec3(
    Number.isFinite(vel?.vx) ? vel.vx : 0,
    Number.isFinite(vel?.vy) ? vel.vy : 0,
    Number.isFinite(vel?.vz) ? vel.vz : 0
  );
  const into = carVel.dot(normal);
  const sliding = carVel.vsub(normal.scale(into));
  // Always leaves faster than the car, else the car catches it and carries it on the nose.
  const closing = Math.max(into, 0);
  const out = closing + Math.min(closing * PED_RESTITUTION + 2, MAX_SEPARATION_SPEED);
  const speed = Math.hypot(carVel.x, carVel.z);
  body.velocity.copy(normal.scale(out).vadd(sliding.scale(TANGENT_DRAG)));
  body.velocity.y += Math.min(1.8 + speed * 0.08, 4.5);

  const horiz = Math.hypot(body.velocity.x, body.velocity.z);
  const dirX = horiz > 0.4 ? body.velocity.x / horiz : normal.x;
  const dirZ = horiz > 0.4 ? body.velocity.z / horiz : normal.z;
  const spin = Math.min(3.5 + speed * 0.12, 8);
  body.angularVelocity.set(-dirZ * spin, 0, dirX * spin);
}

function applyLaunch(body, vel) {
  const vx = Number.isFinite(vel?.vx) ? vel.vx : 0;
  const vz = Number.isFinite(vel?.vz) ? vel.vz : 0;
  const horiz = Math.hypot(vx, vz);
  let dirX = 1;
  let dirZ = 0;
  if (horiz > 0.4) {
    dirX = vx / horiz;
    dirZ = vz / horiz;
  }
  const kick = Math.min(5 + horiz * 0.85, 26);
  const up = Math.min(1.8 + horiz * 0.08, 4.5);
  body.velocity.set(dirX * kick, up, dirZ * kick);
  const spin = Math.min(3.5 + horiz * 0.12, 8);
  body.angularVelocity.set(-dirZ * spin, 0, dirX * spin);
}

function cellHash(ix, iz) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return h >>> 0;
}

function cellHasPed() {
  return true;
}

function pointInCell(ix, iz) {
  const h = cellHash(ix, iz);
  const fx = 0.2 + ((h % 1000) / 1000) * 0.6;
  const fz = 0.2 + (((h >>> 10) % 1000) / 1000) * 0.6;
  return { x: (ix + fx) * CELL_M, z: (iz + fz) * CELL_M };
}

const SHARED_GEOS = new Set([HEAD_GEO, BODY_GEO, ARM_GEO, LEG_GEO]);

function buildPed() {
  const group = new THREE.Group();
  const add = (geo, material, x, y, z) => {
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
  };
  add(LEG_GEO, INK, -0.1, 0.22, 0);
  add(LEG_GEO, INK, 0.1, 0.22, 0);
  add(BODY_GEO, YELLOW, 0, 0.68, 0);
  add(ARM_GEO, YELLOW, -0.3, 0.72, 0);
  add(ARM_GEO, YELLOW, 0.3, 0.72, 0);
  add(HEAD_GEO, YELLOW, 0, 1.18, 0);
  return group;
}
