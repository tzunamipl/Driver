// Simple white posts along both edges of OSM roads, as 3D cues for where the
// road runs. Placed from the streets layer's segments (vectorLineLayer.js) at
// a fixed spacing along each line, in one InstancedMesh around the car.
// Posts near the car get a trigger body (like pedestrians.js): a chassis box
// passing through one swaps it for a tumbling body. Knocked posts are local
// only and stand again once they've left the draw distance.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GROUND_COLLISION_GROUP, GROUND_MATERIAL } from './terrain.js';
import { BUILDING_COLLISION_GROUP, BUILDING_MATERIAL } from './buildings.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { latLonToLocal, localToLatLon } from './geo.js';
import { ROAD_POST_SPACING_M, ROAD_POST_DRAW_DISTANCE_M } from '../config.js';

const POST_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary']);
const SKIP_BRUNNELS = new Set(['bridge', 'tunnel']); // not on the terrain surface
const EDGE_OFFSET_M = -1.0; // outside the stripe edge; negative = inside the road
const JUNCTION_CHECK_M = 0.1; // just past the edge: another road there drops the post, wherever it stands
const POST_HEIGHT_M = 1;
const POST_WIDTH_M = 0.12;
const POST_SINK_M = 0.1; // below the surface, so slopes don't show a gap
const BAND_HEIGHT_M = 0.2; // dark band at the top
const REBUILD_MOVE_M = 10;
const REBUILD_INTERVAL_S = 0.5; // also picks up new terrain / street data
const FILL_BUDGET_MS = 2; // per frame, for placing posts on newly seen segments
const INITIAL_CAPACITY = 512;
const POST_GROUP = 64;
const LOCAL_CHASSIS_GROUP = 1;
const TRIGGER_RADIUS_M = 40; // > REBUILD_MOVE_M plus a frame of top speed
const TRIGGER_PAD_M = 0.05; // trigger slightly fatter than the mesh
const DEBRIS_MASS = 4;
const DEBRIS_SPHERE_RADIUS = 0.07;
const DEBRIS_SPHERE_YS = [-0.4, 0, 0.4]; // from the post's middle; spheres, since boxes snag on the heightfield
const DEBRIS_SPEED_FACTOR = 1.15; // of the car's velocity, so it flies clear ahead
const DEBRIS_UP_SPEED = 2.5;
const DEBRIS_SIDE_SPEED = 2; // away from the car's centreline
const DEBRIS_SPIN = 8; // rad/s
// At rest this long, its body goes and the mesh stays where it lies.
const DEBRIS_REST_SPEED = 0.3; // m/s
const DEBRIS_REST_S = 1;
// Still moving after this (fell through the ground or off the physics tiles): hidden and dropped.
const DEBRIS_MAX_S = 30;
const DEBRIS_MATERIAL = new CANNON.Material('roadPost');

function createPostGeometry() {
  const bodyHeight = POST_HEIGHT_M + POST_SINK_M - BAND_HEIGHT_M;
  const body = new THREE.BoxGeometry(POST_WIDTH_M, bodyHeight, POST_WIDTH_M).translate(0, bodyHeight / 2 - POST_SINK_M, 0);
  const band = new THREE.BoxGeometry(POST_WIDTH_M, BAND_HEIGHT_M, POST_WIDTH_M).translate(
    0,
    POST_HEIGHT_M - BAND_HEIGHT_M / 2,
    0
  );
  const paint = (geometry, hex) => {
    const c = new THREE.Color(hex);
    const count = geometry.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  };
  return mergeGeometries([paint(body, 0xf2f2f2), paint(band, 0x1a1a1a)]);
}

const MID_Y = POST_HEIGHT_M / 2;

/**
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {CANNON.World} deps.world
 * @param {import('./streets.js').StreetsManager} deps.streets
 * @param {import('./terrain.js').TerrainManager} deps.terrain
 * @param {(speed: number) => void} [deps.onHit] - the car knocked a post over (sound).
 */
export function createRoadPosts({
  scene,
  world,
  streets,
  terrain,
  onHit = () => {},
  spacing = ROAD_POST_SPACING_M,
  drawDistance = ROAD_POST_DRAW_DISTANCE_M,
}) {
  const geometry = createPostGeometry();
  const debrisGeometry = geometry.clone().translate(0, -MID_Y, 0); // origin at the body centre
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
  const triggerShape = new CANNON.Box(
    new CANNON.Vec3(POST_WIDTH_M / 2 + TRIGGER_PAD_M, MID_Y, POST_WIDTH_M / 2 + TRIGGER_PAD_M)
  );
  // The world default friction is near zero; without these a post slides for hundreds of metres.
  world.addContactMaterial(
    new CANNON.ContactMaterial(DEBRIS_MATERIAL, GROUND_MATERIAL, { friction: 0.6, restitution: 0.2 })
  );
  world.addContactMaterial(
    new CANNON.ContactMaterial(DEBRIS_MATERIAL, BUILDING_MATERIAL, { friction: 0.4, restitution: 0.3 })
  );
  let mesh = null;
  const triggers = new Map(); // post -> static trigger body
  const knocked = new Map(); // post -> { mesh, body, age, restAge }
  const pendingHits = []; // { post, by }, queued during the physics step
  // Segment -> [{lat, lon}] post positions (junction-filtered); lat/lon survives origin shifts.
  let postsBySegment = new WeakMap();
  const matrix = new THREE.Matrix4();
  let lastX = Infinity;
  let lastZ = Infinity;
  let sinceRebuild = Infinity;
  let dirty = true;

  function ensureCapacity(count) {
    if (mesh && mesh.instanceMatrix.count >= count) return;
    let capacity = mesh ? mesh.instanceMatrix.count : INITIAL_CAPACITY;
    while (capacity < count) capacity *= 2;
    if (mesh) {
      scene.remove(mesh);
      mesh.dispose();
    }
    mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.frustumCulled = false; // instances span the whole draw distance around the car
    mesh.castShadow = true;
    mesh.count = 0;
    scene.add(mesh);
  }

  /** Post positions for one segment, both sides, minus any landing on another road. */
  function placePosts(seg) {
    const out = [];
    const { style } = seg;
    if (seg.buffer || !POST_CLASSES.has(style.key.replace(/_construction$/, '')) || SKIP_BRUNNELS.has(style.brunnel)) {
      return out;
    }
    const { originLat, originLon, scaleLat } = streets;
    const a = latLonToLocal(seg.a.lat, seg.a.lon, originLat, originLon, scaleLat);
    const b = latLonToLocal(seg.b.lat, seg.b.lon, originLat, originLon, scaleLat);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6 || seg.len < 1e-6) return out;
    const nx = -dz / length;
    const nz = dx / length;
    const halfWidth = style.linewidth / 2;
    const offset = halfWidth + EDGE_OFFSET_M;
    const checkOffset = halfWidth + Math.max(EDGE_OFFSET_M, JUNCTION_CHECK_M); // never inside its own stripe
    // Half-open [dist, dist + len), so a post on a piece boundary isn't placed twice.
    for (let k = Math.ceil(seg.dist / spacing); k * spacing < seg.dist + seg.len; k++) {
      const t = (k * spacing - seg.dist) / seg.len;
      const cx = a.x + dx * t;
      const cz = a.z + dz * t;
      for (const side of [-1, 1]) {
        if (streets.containsPoint(cx + nx * checkOffset * side, cz + nz * checkOffset * side)) continue;
        const px = cx + nx * offset * side;
        const pz = cz + nz * offset * side;
        out.push(localToLatLon(px, pz, originLat, originLon, scaleLat));
      }
    }
    return out;
  }

  function addTrigger(post, x, y, z) {
    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.STATIC,
      collisionResponse: false, // wheel rays skip it too
      collisionFilterGroup: POST_GROUP,
      collisionFilterMask: LOCAL_CHASSIS_GROUP,
    });
    body.addShape(triggerShape);
    body.position.set(x, y + MID_Y, z);
    body.addEventListener('collide', (event) => pendingHits.push({ post, by: event.body }));
    world.addBody(body);
    triggers.set(post, body);
  }

  function removeTrigger(post) {
    const body = triggers.get(post);
    if (!body) return;
    world.removeBody(body);
    triggers.delete(post);
  }

  /** Swaps a standing post for a tumbling body thrown along the car's velocity. */
  function knock(post, trigger, by) {
    const { x, y, z } = trigger.position;
    removeTrigger(post);
    const debrisMesh = new THREE.Mesh(debrisGeometry, material);
    debrisMesh.castShadow = true;
    scene.add(debrisMesh);

    const body = new CANNON.Body({
      mass: DEBRIS_MASS,
      material: DEBRIS_MATERIAL,
      linearDamping: 0.1,
      angularDamping: 0.3,
      collisionFilterGroup: POST_GROUP,
      collisionFilterMask: GROUND_COLLISION_GROUP | BUILDING_COLLISION_GROUP,
    });
    for (const sy of DEBRIS_SPHERE_YS) body.addShape(new CANNON.Sphere(DEBRIS_SPHERE_RADIUS), new CANNON.Vec3(0, sy, 0));
    body.position.set(x, y, z);
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
    knocked.set(post, { mesh: debrisMesh, body, age: 0, restAge: 0 });
    onHit(Math.hypot(v.x, v.y, v.z));
  }

  function flushHits() {
    let hit = false;
    for (const { post, by } of pendingHits.splice(0)) {
      const trigger = triggers.get(post);
      if (!trigger || knocked.has(post)) continue;
      knock(post, trigger, by);
      hit = true;
    }
    return hit;
  }

  function updateDebris(dt, x, z) {
    const maxDistSq = drawDistance * drawDistance;
    for (const [post, debris] of knocked) {
      const { mesh: debrisMesh, body } = debris;
      const dx = debrisMesh.position.x - x;
      const dz = debrisMesh.position.z - z;
      if (dx * dx + dz * dz > maxDistSq) {
        if (body) world.removeBody(body);
        scene.remove(debrisMesh);
        knocked.delete(post);
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
    const positions = [];
    const nearPosts = new Set();
    let complete = true; // false = fill budget ran out, rebuild next frame
    for (const seg of streets.itemsWithin(x, z, drawDistance)) {
      let posts = postsBySegment.get(seg);
      if (!posts) {
        if (performance.now() >= deadline) {
          complete = false;
          continue;
        }
        posts = placePosts(seg);
        postsBySegment.set(seg, posts);
      }
      for (const p of posts) {
        if (knocked.has(p)) continue;
        const local = latLonToLocal(p.lat, p.lon, originLat, originLon, scaleLat);
        const ddx = local.x - x;
        const ddz = local.z - z;
        const distSq = ddx * ddx + ddz * ddz;
        if (distSq > maxDistSq) continue;
        const y = terrain.surfaceHeightAt(local.x, local.z);
        if (y == null) continue; // retried on the next interval rebuild
        positions.push(local.x, y, local.z);
        if (distSq <= triggerDistSq) {
          nearPosts.add(p);
          const trigger = triggers.get(p);
          if (!trigger) addTrigger(p, local.x, y, local.z);
          else trigger.position.set(local.x, y + MID_Y, local.z); // terrain may have refined
        }
      }
    }
    for (const post of Array.from(triggers.keys())) {
      if (!nearPosts.has(post)) removeTrigger(post);
    }

    const count = positions.length / 3;
    ensureCapacity(count);
    mesh.position.set(0, 0, 0);
    for (let i = 0; i < count; i++) {
      matrix.makeTranslation(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      mesh.setMatrixAt(i, matrix);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
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
