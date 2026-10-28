// Knockable roadside objects (roadPosts.js, guardRails.js, streetLamps.js, roadSigns.js, directionSigns.js) placed from the
// streets layer's segments (vectorLineLayer.js), one InstancedMesh per kind
// around the car. Objects near the car get a trigger body (knockable.js):
// a chassis box passing through one swaps it for a tumbling body. Knocked objects are local only and stand again once they've left the
// draw distance.
//
// A kind: { geometry (origin on the ground), material, halfExtents {x, y, z}
// (trigger box, standing on the ground), debrisSpheres [[x, y, z]] (from the
// box centre), debrisRadius, mass, group (visibility toggle name), hitSound
// ('metal' or default plastic), followSlope (sheared along local x to the ground's slope, posts stay upright),
// place(seg) -> [{ lat, lon, yaw, ...data }] or null (not ready, asked again later) }.
// Kinds whose items differ (sign text) give buildMesh(item) -> Object3D (origin
// on the ground) instead of geometry/material and get one mesh per item.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { latLonToLocal } from './geo.js';
import { createTrigger, launchDebris, settleDebris } from './knockable.js';
import { ROADSIDE_DRAW_DISTANCE_M } from '../config.js';

export const ROADSIDE_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const SKIP_BRUNNELS = new Set(['bridge', 'tunnel']); // not on the terrain surface

/** True if roadside objects go along this segment's road (class and on the terrain). */
export function isRoadsideRoad(style) {
  return ROADSIDE_CLASSES.has(style.key.replace(/_construction$/, '')) && !SKIP_BRUNNELS.has(style.brunnel);
}

const REBUILD_MOVE_M = 10;
const REBUILD_INTERVAL_S = 0.5; // also picks up new terrain / street data
const INITIAL_CAPACITY = 64;
const TRIGGER_RADIUS_M = 40; // > REBUILD_MOVE_M plus a frame of top speed
const TRIGGER_PAD_M = 0.05; // trigger slightly fatter than the mesh

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);

/**
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {CANNON.World} deps.world
 * @param {import('./streets.js').StreetsManager} deps.streets
 * @param {import('./terrain.js').TerrainManager} deps.terrain
 * @param {object[]} deps.kinds - see header.
 * @param {(speed: number, kind: object) => void} [deps.onHit] - the car knocked one over (sound).
 */
export function createRoadside({ scene, world, streets, terrain, kinds, onHit = () => {}, drawDistance = ROADSIDE_DRAW_DISTANCE_M }) {
  const sets = kinds.map((kind) => {
    const h = kind.halfExtents;
    return {
      kind,
      mesh: null,
      debrisGeometry: kind.buildMesh ? null : kind.geometry.clone().translate(0, -h.y, 0), // origin at the box centre
      itemMeshes: kind.buildMesh ? new Map() : null, // item -> Object3D
      enabled: true,
      triggerShape: new CANNON.Box(new CANNON.Vec3(h.x + TRIGGER_PAD_M, h.y, h.z + TRIGGER_PAD_M)),
    };
  });
  const triggers = new Map(); // item -> static trigger body
  const knocked = new Map(); // item -> { mesh, body, age, restAge }
  const pendingHits = []; // { item, by }, queued during the physics step
  // Segment -> { items: [{lat, lon, yaw, set}], pending: [sets not ready yet] }; lat/lon survives origin shifts.
  const itemsBySegment = new WeakMap();
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const shear = new THREE.Matrix4();
  const tilt = new THREE.Quaternion();
  let lastX = Infinity;
  let lastZ = Infinity;
  let sinceRebuild = Infinity;
  let dirty = true;
  let unfilledSegments = 0; // in range, skipped for lack of time
  let version = 0; // bumped by every rebuild

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

  /** Places the segment's items for every kind still pending in `entry`. */
  function placeItems(seg, entry) {
    const pending = [];
    for (const set of entry.pending) {
      const placed = set.kind.place(seg);
      if (!placed) pending.push(set);
      else for (const p of placed) entry.items.push({ ...p, yaw: p.yaw ?? 0, set });
    }
    entry.pending = pending;
  }

  function disposeObject(object) {
    scene.remove(object);
    object.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [o.material ?? []].flat()) {
        m.map?.dispose();
        m.dispose();
      }
    });
  }

  function dropItemMesh(set, item) {
    const object = set.itemMeshes.get(item);
    if (!object) return;
    set.itemMeshes.delete(item);
    disposeObject(object);
  }

  function dropKnocked(item) {
    const debris = knocked.get(item);
    if (debris.body) world.removeBody(debris.body);
    if (item.set.itemMeshes) disposeObject(debris.mesh);
    else scene.remove(debris.mesh);
    knocked.delete(item);
  }

  function addTrigger(item, x, y, z) {
    const body = createTrigger(item.set.triggerShape, (by) => pendingHits.push({ item, by }));
    body.position.set(x, y + item.set.kind.halfExtents.y, z);
    setTriggerRotation(body, item);
    world.addBody(body);
    triggers.set(item, body);
  }

  /** Rise per metre along the item's local x, from the ground at its ends; 0 unless the kind follows the slope. */
  function slopeAt(item, x, z) {
    if (!item.set.kind.followSlope) return 0;
    const h = item.set.kind.halfExtents.x;
    const dx = Math.cos(item.yaw) * h;
    const dz = -Math.sin(item.yaw) * h;
    const a = terrain.surfaceHeightAt(x - dx, z - dz);
    const b = terrain.surfaceHeightAt(x + dx, z + dz);
    return a == null || b == null ? 0 : (b - a) / (2 * h);
  }

  function setTriggerRotation(body, item) {
    quaternion.setFromAxisAngle(UP, item.yaw).multiply(tilt.setFromAxisAngle(FORWARD, Math.atan(item.slope ?? 0)));
    body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  }

  function removeTrigger(item) {
    const body = triggers.get(item);
    if (!body) return;
    world.removeBody(body);
    triggers.delete(item);
  }

  /** Swaps a standing object for a tumbling body thrown along the car's velocity. */
  function knock(item, trigger, by) {
    removeTrigger(item);
    const { kind, debrisGeometry, itemMeshes } = item.set;
    let debrisMesh;
    if (itemMeshes) {
      const object = itemMeshes.get(item) ?? kind.buildMesh(item);
      itemMeshes.delete(item);
      object.position.set(0, -kind.halfExtents.y, 0);
      object.rotation.set(0, 0, 0);
      debrisMesh = new THREE.Group().add(object); // origin at the box centre
    } else {
      debrisMesh = new THREE.Mesh(debrisGeometry, kind.material);
      debrisMesh.castShadow = true;
    }
    scene.add(debrisMesh);

    const body = launchDebris(world, kind, trigger.position, trigger.quaternion, by);
    debrisMesh.position.copy(body.position); // updateDebris's draw-distance check reads it this frame
    debrisMesh.quaternion.copy(body.quaternion);
    knocked.set(item, { mesh: debrisMesh, body, age: 0, restAge: 0 });
    onHit(by.velocity.length(), kind);
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
      const { mesh: debrisMesh } = debris;
      const dx = debrisMesh.position.x - x;
      const dz = debrisMesh.position.z - z;
      if (dx * dx + dz * dz > maxDistSq || !item.set.enabled) {
        dropKnocked(item);
        continue;
      }
      settleDebris(world, debris, dt);
    }
  }

  /** Places objects on newly seen segments until `deadline`; false if it ran out. */
  function rebuild(x, z, deadline) {
    const { originLat, originLon, scaleLat } = streets;
    const maxDistSq = drawDistance * drawDistance;
    const triggerDistSq = TRIGGER_RADIUS_M * TRIGGER_RADIUS_M;
    const transforms = new Map(sets.map((set) => [set, []])); // set -> [x, y, z, yaw, ...]
    const slopes = new Map(sets.map((set) => [set, []])); // set -> [slope, ...]
    const shownItems = new Set(); // per-item meshes placed this rebuild
    const nearItems = new Set();
    let complete = true; // false = fill budget ran out, rebuild next frame
    unfilledSegments = 0;
    for (const seg of streets.itemsWithin(x, z, drawDistance)) {
      let entry = itemsBySegment.get(seg);
      if (!entry || entry.pending.length) {
        if (performance.now() < deadline) {
          if (!entry) itemsBySegment.set(seg, (entry = { items: [], pending: sets }));
          placeItems(seg, entry); // kinds still not ready retry on the next rebuild
        } else if (!entry) {
          complete = false;
          unfilledSegments++;
          continue;
        }
      }
      for (const item of entry.items) {
        if (knocked.has(item) || !item.set.enabled) continue;
        const local = latLonToLocal(item.lat, item.lon, originLat, originLon, scaleLat);
        const ddx = local.x - x;
        const ddz = local.z - z;
        const distSq = ddx * ddx + ddz * ddz;
        if (distSq > maxDistSq) continue;
        const y = terrain.surfaceHeightAt(local.x, local.z);
        if (y == null) continue; // retried on the next interval rebuild
        item.slope = slopeAt(item, local.x, local.z);
        if (item.set.itemMeshes) {
          let object = item.set.itemMeshes.get(item);
          if (!object) {
            object = item.set.kind.buildMesh(item);
            item.set.itemMeshes.set(item, object);
            scene.add(object);
          }
          object.position.set(local.x, y, local.z);
          object.rotation.set(0, item.yaw, 0);
          shownItems.add(item);
        } else {
          transforms.get(item.set).push(local.x, y, local.z, item.yaw);
          slopes.get(item.set).push(item.slope);
        }
        if (distSq <= triggerDistSq) {
          nearItems.add(item);
          const trigger = triggers.get(item);
          if (!trigger) addTrigger(item, local.x, y, local.z);
          else {
            trigger.position.set(local.x, y + item.set.kind.halfExtents.y, local.z); // terrain may have refined
            setTriggerRotation(trigger, item);
          }
        }
      }
    }
    for (const item of Array.from(triggers.keys())) {
      if (!nearItems.has(item)) removeTrigger(item);
    }

    for (const set of sets) {
      if (!set.itemMeshes) continue;
      for (const item of Array.from(set.itemMeshes.keys())) {
        if (!shownItems.has(item)) dropItemMesh(set, item);
      }
    }

    for (const [set, t] of transforms) {
      if (set.itemMeshes) continue;
      const count = t.length / 4;
      ensureCapacity(set, count);
      set.mesh.position.set(0, 0, 0);
      for (let i = 0; i < count; i++) {
        position.set(t[i * 4], t[i * 4 + 1], t[i * 4 + 2]);
        quaternion.setFromAxisAngle(UP, t[i * 4 + 3]);
        matrix.compose(position, quaternion, scale);
        const k = slopes.get(set)[i];
        if (k) matrix.multiply(shear.set(1, 0, 0, 0, k, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)); // y += k * x
        set.mesh.setMatrixAt(i, matrix);
      }
      set.mesh.count = count;
      set.mesh.instanceMatrix.needsUpdate = true;
      set.placed = t;
    }
    version++;
    return complete;
  }

  return {
    /** Call once per frame with the car's world position; places new objects until `deadline`. */
    update(dt, x, z, deadline = Infinity) {
      sinceRebuild += dt;
      const hit = flushHits();
      updateDebris(dt, x, z);
      const moved = Math.hypot(x - lastX, z - lastZ) >= REBUILD_MOVE_M;
      if (!dirty && !hit && !moved && sinceRebuild < REBUILD_INTERVAL_S) return;
      lastX = x;
      lastZ = z;
      sinceRebuild = 0;
      dirty = !rebuild(x, z, deadline);
    },

    /** Streaming indicator: in-range street segments still to place objects on. */
    pendingWork() {
      return { downloads: 0, builds: unfilledSegments };
    },

    /** Graphics detail: draw distance in metres. */
    setDrawDistance(metres) {
      drawDistance = metres;
      dirty = true;
    },

    /** Debug HUD: standing objects per group, { group: count }. */
    getCounts() {
      const counts = {};
      for (const set of sets) {
        const n = set.itemMeshes ? set.itemMeshes.size : set.mesh?.count ?? 0;
        counts[set.kind.group] = (counts[set.kind.group] ?? 0) + n;
      }
      return counts;
    },

    /** Shows/hides (and stops colliding with) every kind of a `group`. */
    setGroupVisible(group, visible) {
      for (const set of sets) {
        if (set.kind.group === group && set.enabled !== visible) {
          set.enabled = visible;
          dirty = true;
        }
      }
    },

    /** Standing per-item objects of a `group`: [{ item, object }] (object at its world position). */
    standing(group) {
      const out = [];
      for (const set of sets) {
        if (set.kind.group !== group || !set.itemMeshes) continue;
        for (const [item, object] of set.itemMeshes) out.push({ item, object });
      }
      return out;
    },

    /**
     * Standing instanced objects of a `group` as flat [x, y, z, yaw, ...] in current world
     * coords, plus `version`, which changes whenever the set may have.
     */
    standingTransforms(group) {
      const transforms = [];
      for (const set of sets) {
        if (set.kind.group !== group || !set.mesh || !set.placed) continue;
        const { x, z } = set.mesh.position; // origin shifts since the last rebuild
        const t = set.placed;
        for (let i = 0; i < t.length; i += 4) transforms.push(t[i] + x, t[i + 1], t[i + 2] + z, t[i + 3]);
      }
      return { transforms, version };
    },

    /**
     * Compiles every kind's shaders (standing instances + debris) against `scene`'s lights, so the first
     * object in range or knocked over doesn't stall a frame. Call once the local car's lamps are in the scene.
     * Per-item kinds (direction boards) share the instanced kinds' debris programs (same material setup).
     */
    warmUp(renderer, camera) {
      const probe = new THREE.Group();
      for (const set of sets) {
        if (!set.debrisGeometry) continue;
        probe.add(new THREE.InstancedMesh(set.kind.geometry, set.kind.material, 1), new THREE.Mesh(set.debrisGeometry, set.kind.material));
      }
      return renderer.compileAsync(probe, camera, scene).catch((err) => console.warn('Roadside shader warm-up failed', err));
    },

    /** Meshes and bodies are moved by the generic shift; the next rebuild re-bases the instances. */
    shiftOrigin(dx, dz) {
      lastX -= dx;
      lastZ -= dz;
    },
  };
}
