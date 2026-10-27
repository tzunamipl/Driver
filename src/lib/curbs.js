// Low curbs along both edges of paved road-bed roads in built-up areas, broken
// wherever another road's stripe would run into them (junctions, driveways).
// Meshes per CHUNK_ZOOM tile around the car; near the car every run also gets
// a ray-only static box, so the wheels ride over the step but nothing collides with it.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { latLonToLocal, lon2tileX, lat2tileY } from './geo.js';
import { onRoadBed } from './terrain/roadBed.js';
import { builtUpReady } from './roadPosts.js';
import { miter, sideNormal } from './vectorLineLayer.js';
import { ROADSIDE_DRAW_DISTANCE_M } from '../config.js';

const CURB_HEIGHT_M = 0.03;
const CURB_WIDTH_M = 0.15;
const CURB_SINK_M = 0.08; // below the ground, so the bed's facets between height samples don't open a gap
const CURB_COLOR = 0xaaa79f;
const SAMPLE_M = 0.5; // junction checks along each edge
const HEIGHT_STEP_M = 1; // the mesh follows the ground at this spacing
const MIN_RUN_M = 0.3; // shorter slivers are dropped, unless they run on into the next segment
const CLEARANCE_M = 0.2; // kept this far off other roads' stripes
// Another road's stripe breaks a curb only if it crosses at this angle (sin) or more, or overlaps it by this
// much: a road running on past a way split or a tile edge doesn't.
const CROSS_MIN_SIN = 0.5;
const PARALLEL_OVERLAP_M = 1;
const CHUNK_ZOOM = 18;
const REBUILD_MOVE_M = 10;
const REBUILD_INTERVAL_S = 1; // also picks up new terrain / street data
const PHYSICS_RADIUS_M = 30; // > REBUILD_MOVE_M plus a frame of top speed
const BOX_OVERLAP_M = 0.05; // boxes reach this far past their run's ends, so a ray can't slip between two
// Ray-only: the wheel rays (group -1) hit it, but no body's group has this bit, so nothing collides with it.
export const CURB_COLLISION_GROUP = 128;

const NO_SIDES = [];

/**
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {CANNON.World} deps.world
 * @param {import('./streets.js').StreetsManager} deps.streets
 * @param {import('./builtUpAreas.js').BuiltUpAreasManager} deps.builtUpAreas
 * @param {import('./terrain.js').TerrainManager} deps.terrain
 */
export function createCurbs({ scene, world, streets, builtUpAreas, terrain, drawDistance = ROADSIDE_DRAW_DISTANCE_M }) {
  const material = new THREE.MeshStandardMaterial({ color: CURB_COLOR, roughness: 0.85, flatShading: true });
  // Segment -> { chunk, sides: [{ side, ma, mb, runs: [t0, t1, ...] }] }; null entries = data not in yet.
  const runsBySegment = new WeakMap();
  // Chunk key -> { mesh, entries, frame, probes: [x, z, heightfield, ...], boxes: [{ position, quaternion, shape }] }.
  const chunks = new Map();
  const bodies = new Map(); // box -> static body
  let visible = true;
  let lastX = Infinity;
  let lastZ = Infinity;
  let sinceRebuild = Infinity;
  let dirty = true;

  // Local coordinates change with the origin (floating-origin shift, teleport).
  const frameKey = () => `${streets.originLat},${streets.originLon}`;
  const toLocal = ({ lat, lon }) => latLonToLocal(lat, lon, streets.originLat, streets.originLon, streets.scaleLat);

  /** True if another road's stripe reaches the curb point (x, z) on a segment heading (dx, dz). */
  function blocked(seg, x, z, dx, dz) {
    for (const other of streets.segmentsAt(x, z, CURB_WIDTH_M / 2 + CLEARANCE_M)) {
      if (other.line === seg.line || !onRoadBed(other.style.key, other.style.brunnel)) continue;
      const oa = toLocal(other.a);
      const ob = toLocal(other.b);
      const ol = Math.hypot(ob.x - oa.x, ob.z - oa.z) || 1;
      const sin = Math.abs(dx * (ob.z - oa.z) - dz * (ob.x - oa.x)) / ol;
      if (sin >= CROSS_MIN_SIN || streets.segmentMargin(other, x, z) >= CURB_WIDTH_M / 2 + PARALLEL_OVERLAP_M) return true;
    }
    return false;
  }

  /** Curb runs of one segment, or null until its built-up data is in. */
  function placeRuns(seg) {
    const { style } = seg;
    const mid = { lat: (seg.a.lat + seg.b.lat) / 2, lon: (seg.a.lon + seg.b.lon) / 2 };
    const chunk = `${Math.floor(lon2tileX(mid.lon, CHUNK_ZOOM))}/${Math.floor(lat2tileY(mid.lat, CHUNK_ZOOM))}`;
    // Buffer copies: the neighbouring tile's segment carries the curb.
    if (seg.buffer || style.unpaved || style.key.endsWith('_construction') || !onRoadBed(style.key, style.brunnel)) {
      return { chunk, sides: NO_SIDES };
    }
    if (!builtUpReady(builtUpAreas, seg)) return null;
    const a = toLocal(seg.a);
    const b = toLocal(seg.b);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-3 || !builtUpAreas.isBuiltUpAt((a.x + b.x) / 2, (a.z + b.z) / 2)) return { chunk, sides: NO_SIDES };
    // Unit mitred offsets at both ends, shared with the stripe (vectorLineLayer.js), so curbs run on without gaps.
    const n = sideNormal(a, b);
    const prev = seg.line?.[seg.index - 1];
    const next = seg.line?.[seg.index + 1];
    const ma = prev ? miter(sideNormal(toLocal(prev.a), a), n, 1) : n;
    const mb = next ? miter(n, sideNormal(b, toLocal(next.b)), 1) : n;
    const centre = style.linewidth / 2 + CURB_WIDTH_M / 2;
    const count = Math.max(1, Math.ceil(length / SAMPLE_M));
    const half = 0.5 / count;
    const sides = [];
    for (const side of [-1, 1]) {
      const runs = [];
      let start = null;
      for (let k = 0; k <= count; k++) {
        const t = k / count;
        const ox = side * centre * (ma[0] + (mb[0] - ma[0]) * t);
        const oz = side * centre * (ma[1] + (mb[1] - ma[1]) * t);
        const free = !blocked(seg, a.x + dx * t + ox, a.z + dz * t + oz, dx / length, dz / length);
        if (free && start == null) start = k ? t - half : 0;
        if ((!free || k === count) && start != null) {
          const end = free ? 1 : t - half;
          if (start === 0 || end === 1 || (end - start) * length >= MIN_RUN_M) runs.push(start, end);
          start = null;
        }
      }
      if (runs.length) sides.push({ side, ma, mb, runs });
    }
    return { chunk, sides };
  }

  /** Ground y under (x, z) (the road bed's heightfield where loaded); records which heightfield it came from. */
  function groundAt(x, z, probes) {
    const heightfield = terrain.detailHeightfieldAt(x, z);
    if (!probes.includes(heightfield)) probes.push(x, z, heightfield);
    return (heightfield ? terrain.detailHeightAt(x, z) : terrain.surfaceHeightAt(x, z)) ?? null;
  }

  /** Mesh (positions in the current frame) and physics boxes of a chunk's runs. */
  function buildChunk(entries) {
    const positions = [];
    const boxes = [];
    const probes = [];
    const quad = (p0, p1, p2, p3, out) => {
      // Wound to face `out`.
      const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
      const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
      const facing = (uy * vz - uz * vy) * out[0] + (uz * vx - ux * vz) * out[1] + (ux * vy - uy * vx) * out[2];
      const order = facing >= 0 ? [p0, p1, p2, p0, p2, p3] : [p0, p2, p1, p0, p3, p2];
      for (const p of order) positions.push(p[0], p[1], p[2]);
    };
    for (const { seg, sides } of entries) {
      const a = toLocal(seg.a);
      const b = toLocal(seg.b);
      const hw = seg.style.linewidth / 2;
      for (const { side, ma, mb, runs } of sides) {
        // Inner (road side) and outer edge at t along the segment.
        const edge = (t, w) => [
          a.x + (b.x - a.x) * t + side * w * (ma[0] + (mb[0] - ma[0]) * t),
          a.z + (b.z - a.z) * t + side * w * (ma[1] + (mb[1] - ma[1]) * t),
        ];
        for (let r = 0; r < runs.length; r += 2) {
          const t0 = runs[r];
          const t1 = runs[r + 1];
          const steps = Math.max(1, Math.ceil((Math.hypot(b.x - a.x, b.z - a.z) * (t1 - t0)) / HEIGHT_STEP_M));
          const rows = []; // [innerTop, outerTop, innerBottom, outerBottom] per step
          let complete = true;
          for (let k = 0; k <= steps; k++) {
            const t = t0 + ((t1 - t0) * k) / steps;
            const [ix, iz] = edge(t, hw);
            const [ox, oz] = edge(t, hw + CURB_WIDTH_M);
            const y = groundAt((ix + ox) / 2, (iz + oz) / 2, probes);
            if (y == null) {
              complete = false;
              break;
            }
            const top = y + CURB_HEIGHT_M;
            const bottom = y - CURB_SINK_M;
            rows.push([[ix, top, iz], [ox, top, oz], [ix, bottom, iz], [ox, bottom, oz]]);
          }
          if (!complete) continue; // terrain not in yet: the probe makes the chunk rebuild once it is
          const first = rows[0];
          const last = rows[steps];
          const along = [last[0][0] - first[0][0], 0, last[0][2] - first[0][2]];
          const outward = [first[1][0] - first[0][0], 0, first[1][2] - first[0][2]];
          for (let k = 0; k < steps; k++) {
            const [it0, ot0, ib0, ob0] = rows[k];
            const [it1, ot1, ib1, ob1] = rows[k + 1];
            quad(it0, it1, ot1, ot0, [0, 1, 0]);
            quad(ib0, ib1, it1, it0, outward.map((v) => -v));
            quad(ot0, ot1, ob1, ob0, outward);
          }
          quad(first[2], first[0], first[1], first[3], along.map((v) => -v));
          quad(last[2], last[0], last[1], last[3], along);
          boxes.push(runBox(first, last));
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    return { mesh, boxes, probes };
  }

  /** Box under a run's top from its first to last row, tilted along it. */
  function runBox(first, last) {
    const cx0 = (first[0][0] + first[1][0]) / 2;
    const cz0 = (first[0][2] + first[1][2]) / 2;
    const cx1 = (last[0][0] + last[1][0]) / 2;
    const cz1 = (last[0][2] + last[1][2]) / 2;
    const run = Math.hypot(cx1 - cx0, cz1 - cz0);
    const rise = last[0][1] - first[0][1];
    const halfHeight = (CURB_HEIGHT_M + CURB_SINK_M) / 2;
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.atan2(rise, run), Math.atan2(cx1 - cx0, cz1 - cz0), 0, 'YXZ'));
    const down = new THREE.Vector3(0, -halfHeight, 0).applyQuaternion(quaternion);
    return {
      position: new THREE.Vector3((cx0 + cx1) / 2, (first[0][1] + last[0][1]) / 2, (cz0 + cz1) / 2).add(down),
      quaternion,
      shape: new CANNON.Box(new CANNON.Vec3(CURB_WIDTH_M / 2, halfHeight, Math.hypot(run, rise) / 2 + BOX_OVERLAP_M)),
    };
  }

  function dropChunk(key) {
    const chunk = chunks.get(key);
    scene.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    chunks.delete(key);
  }

  /** True if the chunk was built from other segments, another frame or terrain that has since changed. */
  function isStale(chunk, entries) {
    if (chunk.frame !== frameKey() || chunk.entries.length !== entries.length) return true;
    if (chunk.entries.some((entry, i) => entry !== entries[i])) return true;
    const p = chunk.probes;
    for (let i = 0; i < p.length; i += 3) if (terrain.detailHeightfieldAt(p[i], p[i + 1]) !== p[i + 2]) return true;
    return false;
  }

  /** Places runs on new segments and (re)builds chunk meshes until `deadline`; false if it ran out. */
  function rebuild(x, z, deadline) {
    let complete = true;
    const wanted = new Map(); // chunk key -> entries
    for (const seg of streets.itemsWithin(x, z, drawDistance)) {
      let entry = runsBySegment.get(seg);
      if (!entry) {
        if (performance.now() >= deadline) {
          complete = false;
          continue;
        }
        const placed = placeRuns(seg);
        if (!placed) continue; // asked again on the next rebuild
        runsBySegment.set(seg, (entry = { seg, ...placed }));
      }
      if (!entry.sides.length) continue;
      const list = wanted.get(entry.chunk);
      if (list) list.push(entry);
      else wanted.set(entry.chunk, [entry]);
    }
    for (const key of Array.from(chunks.keys())) if (!wanted.has(key)) dropChunk(key);
    for (const [key, entries] of wanted) {
      const chunk = chunks.get(key);
      if (chunk && !isStale(chunk, entries)) continue;
      if (performance.now() >= deadline) {
        complete = false;
        continue;
      }
      if (chunk) dropChunk(key);
      const built = buildChunk(entries);
      built.mesh.visible = visible;
      scene.add(built.mesh);
      chunks.set(key, { ...built, entries, frame: frameKey() });
    }
    return complete;
  }

  /** Bodies for the boxes within PHYSICS_RADIUS_M of (x, z); the rest leave the world. */
  function syncBodies(x, z) {
    const near = new Set();
    if (visible) {
      for (const chunk of chunks.values()) {
        const { x: sx, z: sz } = chunk.mesh.position; // origin shifts since the build
        for (const box of chunk.boxes) {
          if (Math.hypot(box.position.x + sx - x, box.position.z + sz - z) > PHYSICS_RADIUS_M) continue;
          near.add(box);
          if (bodies.has(box)) continue;
          const body = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC, collisionFilterGroup: CURB_COLLISION_GROUP, collisionFilterMask: CURB_COLLISION_GROUP });
          body.addShape(box.shape);
          body.position.set(box.position.x + sx, box.position.y, box.position.z + sz);
          body.quaternion.set(box.quaternion.x, box.quaternion.y, box.quaternion.z, box.quaternion.w);
          world.addBody(body);
          bodies.set(box, body);
        }
      }
    }
    for (const [box, body] of bodies) {
      if (near.has(box)) continue;
      world.removeBody(body);
      bodies.delete(box);
    }
  }

  return {
    /** Call once per frame with the car's world position; builds until `deadline`. */
    update(dt, x, z, deadline = Infinity) {
      sinceRebuild += dt;
      const moved = Math.hypot(x - lastX, z - lastZ) >= REBUILD_MOVE_M;
      if (!dirty && !moved && sinceRebuild < REBUILD_INTERVAL_S) return;
      lastX = x;
      lastZ = z;
      sinceRebuild = 0;
      dirty = !rebuild(x, z, deadline);
      syncBodies(x, z);
    },

    /** Graphics detail: draw distance in metres. */
    setDrawDistance(metres) {
      drawDistance = metres;
      dirty = true;
    },

    /** Shows/hides the curbs; hidden ones don't touch the wheels either. */
    setVisible(on) {
      visible = on;
      for (const chunk of chunks.values()) chunk.mesh.visible = on;
      dirty = true;
    },

    /** Meshes and bodies are moved by the generic shift; chunks rebuild in the new frame. */
    shiftOrigin(dx, dz) {
      lastX -= dx;
      lastZ -= dz;
    },
  };
}
