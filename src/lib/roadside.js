// Knockable roadside objects (roadPosts.js, roadSigns.js) placed from the
// streets layer's segments (vectorLineLayer.js), one InstancedMesh per kind
// around the car. Objects near the car get a trigger body (like
// pedestrians.js): a chassis box passing through one swaps it for a tumbling
// body. Knocked objects are local only and stand again once they've left the
// draw distance.
//
// A kind: { geometry (origin on the ground), material, halfExtents {x, y, z}
// (trigger box, standing on the ground), debrisSpheres [[x, y, z]] (from the
// box centre), debrisRadius, mass, place(seg) -> [{ lat, lon, yaw }] }.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GROUND_COLLISION_GROUP, GROUND_MATERIAL } from './terrain.js';
import { BUILDING_COLLISION_GROUP, BUILDING_MATERIAL } from './buildings.js';
import { latLonToLocal } from './geo.js';
import { ROADSIDE_DRAW_DISTANCE_M } from '../config.js';

export const ROADSIDE_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary']);
const SKIP_BRUNNELS = new Set(['bridge', 'tunnel']); // not on the terrain surface

/** True if roadside objects go along this segment's road (class and on the terrain). */
export function isRoadsideRoad(style) {
  return ROADSIDE_CLASSES.has(style.key.replace(/_construction$/, '')) && !SKIP_BRUNNELS.has(style.brunnel);
}

const REBUILD_MOVE_M = 10;
const REBUILD_INTERVAL_S = 0.5; // also picks up new terrain / street data
const FILL_BUDGET_MS = 2; // per frame, for placing objects on newly seen segments
const INITIAL_CAPACITY = 64;
const ROADSIDE_GROUP = 64;
const LOCAL_CHASSIS_GROUP = 1;
const TRIGGER_RADIUS_M = 40; // > REBUILD_MOVE_M plus a frame of top speed
const TRIGGER_PAD_M = 0.05; // trigger slightly fatter than the mesh
const DEBRIS_SPEED_FACTOR = 1.15; // of the car's velocity, so it flies clear ahead
const DEBRIS_UP_SPEED = 2.5;
const DEBRIS_SIDE_SPEED = 2; // away from the car's centreline
const DEBRIS_SPIN = 8; // rad/s
// At rest this long, its body goes and the mesh stays where it lies.
const DEBRIS_REST_SPEED = 0.3; // m/s
const DEBRIS_REST_S = 1;
// Still moving after this (fell through the ground or off the physics tiles): hidden and dropped.
const DEBRIS_MAX_S = 30;
const DEBRIS_MATERIAL = new CANNON.Material('roadside');

const UP = new THREE.Vector3(0, 1, 0);

/**
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {CANNON.World} deps.world
 * @param {import('./streets.js').StreetsManager} deps.streets
 * @param {import('./terrain.js').TerrainManager} deps.terrain
 * @param {object[]} deps.kinds - see header.
 * @param {(speed: number) => void} [deps.onHit] - the car knocked one over (sound).
 */
export function createRoadside({ scene, world, streets, terrain, kinds, onHit = () => {}, drawDistance = ROADSIDE_DRAW_DISTANCE_M }) {
  // The world default friction is near zero; without these an object slides for hundreds of metres.
  world.addContactMaterial(
    new CANNON.ContactMaterial(DEBRIS_MATERIAL, GROUND_MATERIAL, { friction: 0.6, restitution: 0.2 })
  );
  world.addContactMaterial(
    new CANNON.ContactMaterial(DEBRIS_MATERIAL, BUILDING_MATERIAL, { friction: 0.4, restitution: 0.3 })
  );
  const sets = kinds.map((kind) => {
    const h = kind.halfExtents;
    return {
      kind,
      mesh: null,
      debrisGeometry: kind.geometry.clone().translate(0, -h.y, 0), // origin at the box centre
      triggerShape: new CANNON.Box(new CANNON.Vec3(h.x + TRIGGER_PAD_M, h.y, h.z + TRIGGER_PAD_M)),
    };
  });
  const triggers = new Map(); // item -> static trigger body
  const knocked = new Map(); // item -> { mesh, body, age, restAge }
  const pendingHits = []; // { item, by }, queued during the physics step
  // Segment -> [{lat, lon, yaw, set}]; lat/lon survives origin shifts.
  const itemsBySegment = new WeakMap();
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  let lastX = Infinity;
  let lastZ = Infinity;
  let sinceRebuild = Infinity;
  let dirty = true;

  function ensureCapacity(set, count) {
    if (set.mesh && set.mesh.instanceMatrix.count >= count) return;
    let capacity = set.mesh ? set.mesh.instanceMatrix.count : INITIAL_CAPACITY;
    while (capacity < count) capacity *= 2;
    if (set.mesh) {
      scene.remove(set.mesh);
      set.mesh.dispose();
    }
    set.mesh = new THREE.InstancedMesh(set.kind.geometry, set.kind.material, capacity);
    set.mesh.frustumCulled = false; // instances span the whole draw distance around the car
    set.mesh.castShadow = true;
    set.mesh.count = 0;
    scene.add(set.mesh);
  }

  function placeItems(seg) {
    const out = [];
    for (const set of sets) {
      for (const p of set.kind.place(seg)) out.push({ lat: p.lat, lon: p.lon, yaw: p.yaw ?? 0, set });
    }
    return out;
  }

  function addTrigger(item, x, y, z) {
    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.STATIC,
      collisionResponse: false, // wheel rays skip it too
      collisionFilterGroup: ROADSIDE_GROUP,
      collisionFilterMask: LOCAL_CHASSIS_GROUP,
    });
    body.addShape(item.set.triggerShape);
    body.position.set(x, y + item.set.kind.halfExtents.y, z);
    body.quaternion.setFromEuler(0, item.yaw, 0);
    body.addEventListener('collide', (event) => pendingHits.push({ item, by: event.body }));
    world.addBody(body);
    triggers.set(item, body);
  }

  function removeTrigger(item) {
    const body = triggers.get(item);
    if (!body) return;
    world.removeBody(body);
    triggers.delete(item);
  }

  /** Swaps a standing object for a tumbling body thrown along the car's velocity. */
  function knock(item, trigger, by) {
    const { x, y, z } = trigger.position;
    removeTrigger(item);
    const { kind, debrisGeometry } = item.set;
    const debrisMesh = new THREE.Mesh(debrisGeometry, kind.material);
    debrisMesh.castShadow = true;
    scene.add(debrisMesh);

    const body = new CANNON.Body({
      mass: kind.mass,
      material: DEBRIS_MATERIAL,
      linearDamping: 0.1,
      angularDamping: 0.3,
      collisionFilterGroup: ROADSIDE_GROUP,
      collisionFilterMask: GROUND_COLLISION_GROUP | BUILDING_COLLISION_GROUP,
    });
    // Spheres, since boxes snag on the heightfield.
    for (const [sx, sy, sz] of kind.debrisSpheres) {
      body.addShape(new CANNON.Sphere(kind.debrisRadius), new CANNON.Vec3(sx, sy, sz));
    }
    body.position.set(x, y, z);
    body.quaternion.copy(trigger.quaternion);
    const v = by.velocity;
    let sx = x - by.position.x;
    let sz = z - by.position.z;
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
    debrisMesh.position.copy(body.position); // updateDebris's draw-distance check reads it this frame
    debrisMesh.quaternion.copy(body.quaternion);
    knocked.set(item, { mesh: debrisMesh, body, age: 0, restAge: 0 });
    onHit(Math.hypot(v.x, v.y, v.z));
  }

  function flushHits() {
    let hit = false;
    for (const { item, by } of pendingHits.splice(0)) {
      const trigger = triggers.get(item);
      if (!trigger || knocked.has(item)) continue;
      knock(item, trigger, by);
      hit = true;
    }
    return hit;
  }

  function updateDebris(dt, x, z) {
    const maxDistSq = drawDistance * drawDistance;
    for (const [item, debris] of knocked) {
      const { mesh: debrisMesh, body } = debris;
      const dx = debrisMesh.position.x - x;
      const dz = debrisMesh.position.z - z;
      if (dx * dx + dz * dz > maxDistSq) {
        if (body) world.removeBody(body);
        scene.remove(debrisMesh);
        knocked.delete(item);
        continue;
      }
      if (!body) continue;
      debrisMesh.position.copy(body.position);
      debrisMesh.quaternion.copy(body.quaternion);
      debris.age += dt;
      const resting =
        body.velocity.lengthSquared() < DEBRIS_REST_SPEED ** 2 && body.angularVelocity.lengthSquared() < 1;
      debris.restAge = resting ? debris.restAge + dt : 0;
      if (debris.restAge >= DEBRIS_REST_S || debris.age >= DEBRIS_MAX_S) {
        if (!resting) debrisMesh.visible = false;
        world.removeBody(body);
        debris.body = null;
      }
    }
  }

  function rebuild(x, z) {
    const { originLat, originLon, scaleLat } = streets;
    const maxDistSq = drawDistance * drawDistance;
    const triggerDistSq = TRIGGER_RADIUS_M * TRIGGER_RADIUS_M;
    const deadline = performance.now() + FILL_BUDGET_MS;
    const transforms = new Map(sets.map((set) => [set, []])); // set -> [x, y, z, yaw, ...]
    const nearItems = new Set();
    let complete = true; // false = fill budget ran out, rebuild next frame
    for (const seg of streets.itemsWithin(x, z, drawDistance)) {
      let items = itemsBySegment.get(seg);
      if (!items) {
        if (performance.now() >= deadline) {
          complete = false;
          continue;
        }
        items = placeItems(seg);
        itemsBySegment.set(seg, items);
      }
      for (const item of items) {
        if (knocked.has(item)) continue;
        const local = latLonToLocal(item.lat, item.lon, originLat, originLon, scaleLat);
        const ddx = local.x - x;
        const ddz = local.z - z;
        const distSq = ddx * ddx + ddz * ddz;
        if (distSq > maxDistSq) continue;
        const y = terrain.surfaceHeightAt(local.x, local.z);
        if (y == null) continue; // retried on the next interval rebuild
        transforms.get(item.set).push(local.x, y, local.z, item.yaw);
        if (distSq <= triggerDistSq) {
          nearItems.add(item);
          const trigger = triggers.get(item);
          if (!trigger) addTrigger(item, local.x, y, local.z);
          else trigger.position.set(local.x, y + item.set.kind.halfExtents.y, local.z); // terrain may have refined
        }
      }
    }
    for (const item of Array.from(triggers.keys())) {
      if (!nearItems.has(item)) removeTrigger(item);
    }

    for (const [set, t] of transforms) {
      const count = t.length / 4;
      ensureCapacity(set, count);
      set.mesh.position.set(0, 0, 0);
      for (let i = 0; i < count; i++) {
        position.set(t[i * 4], t[i * 4 + 1], t[i * 4 + 2]);
        quaternion.setFromAxisAngle(UP, t[i * 4 + 3]);
        set.mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
      }
      set.mesh.count = count;
      set.mesh.instanceMatrix.needsUpdate = true;
    }
    return complete;
  }

  return {
    /** Call once per frame with the car's world position. */
    update(dt, x, z) {
      sinceRebuild += dt;
      const hit = flushHits();
      updateDebris(dt, x, z);
      const moved = Math.hypot(x - lastX, z - lastZ) >= REBUILD_MOVE_M;
      if (!dirty && !hit && !moved && sinceRebuild < REBUILD_INTERVAL_S) return;
      lastX = x;
      lastZ = z;
      sinceRebuild = 0;
      dirty = !rebuild(x, z);
    },

    /** Meshes and bodies are moved by the generic shift; the next rebuild re-bases the instances. */
    shiftOrigin(dx, dz) {
      lastX -= dx;
      lastZ -= dz;
    },
  };
}
