// Forest trees, scrub bushes and rocks: super-low-poly instances (3-sided trunk + smooth-shaded blob crown, or two
// stacked cones for pines - by height and latitude; trunks only within `trunkDistance`) on a jittered
// grid inside landcoverAreas.js polygons of the kind's area (forest / scrub / rock), kept `gap` clear of every street
// line's edge (tunnels aside), river strips and water areas. Bushes are one blob, no trunk. Visual only - no bodies (but rocks: static spheres
// within `physicsDistance`, in the building group so they share its impact responses); no
// shadows unless setShadows() turns them on (debug).
// Trees are placed per DETAIL_ZOOM tile, as fractions of the tile (survive
// origin shifts), once every layer they're checked against has its data there.
// Crowns blend their base green with the aerial photo under them (terrain.groundColorAt).
// Far trees grow up from their foot as they come within the draw distance (vertex shader).

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { latLonToLocal, localToLatLon, lon2tileX, lat2tileY, tileX2lon, tileY2lat, tileSizeMeters } from './geo.js';
import { DETAIL_ZOOM } from './terrain.js';
import { BUILDING_COLLISION_GROUP, BUILDING_MATERIAL } from './buildings.js';
import {
  PINE_ASL_PER_DEG_M,
  PINE_MIX_START_ASL_M,
  PINE_ONLY_ASL_M,
  PINE_REFERENCE_LAT,
  TREE_AREA_PER_TREE_M2,
  TREE_DRAW_DISTANCE_M,
  TREE_GAP_M,
  TREE_GROW_M,
  TREE_TRUNK_DISTANCE_M,
  BUSH_AREA_PER_BUSH_M2,
  BUSH_DRAW_DISTANCE_M,
  BUSH_GAP_M,
  BUSH_GROW_M,
  ROCK_AREA_PER_ROCK_M2,
  ROCK_DRAW_DISTANCE_M,
  ROCK_GAP_M,
  ROCK_GROW_M,
  ROCK_PHYSICS_DISTANCE_M,
} from '../config.js';

const REBUILD_MOVE_M = 20;
const REBUILD_INTERVAL_S = 1; // also picks up refined terrain
const FILL_REBUILD_S = 0.2; // newly placed tiles show at most this often
const INITIAL_CAPACITY = 1024;
const JITTER = 0.8; // of a grid cell
const SCALE_MIN = 0.75;
const SCALE_MAX = 1.3;
// Width on top of the overall scale (crown and trunk), so trees aren't all the same shape.
const WIDTH_MIN = 0.7;
const WIDTH_MAX = 1.35;
const SEGMENT_SLACK_M = 4; // street / river segments are bucketed by midpoint and up to this long
const TRUNK_HEIGHT_M = 7;
const TRUNK_SINK_M = 0.4; // below the ground, so slopes don't show the trunk's foot
const CROWN_RADIUS_M = 3.2;
const CROWN_HALF_HEIGHT_M = 4.5;
const CROWN_CENTER_M = 9.5;
const DISSOLVE_NEAR_M = 120; // trees this close to the car burst into particles when dropped
const CROWN_COLORS = [0x2f5d24, 0x3d7a2a, 0x24491c, 0x4a7f30].map((c) => new THREE.Color(c));
// Pine: two stacked closed cones [base y, radius, height] (5 sides each, 20 triangles in all).
const PINE_TIERS = [
  [3, 3, 7],
  [7, 2.2, 6],
];
const PINE_COLORS = [0x1f3d2a, 0x24452c, 0x2b4f33, 0x1a3524].map((c) => new THREE.Color(c));
const BUSH_RADIUS_M = 1.8;
const BUSH_HALF_HEIGHT_M = 1.2;
const BUSH_CENTER_M = 0.7; // partly sunk, so slopes don't show its underside
const BUSH_COLORS = [0x4b5e2a, 0x5a6b30, 0x3f5124, 0x6b7a3a].map((c) => new THREE.Color(c));
// Rock: a jittered unit icosahedron scaled to its radius, centre sunk so only a cap shows.
const ROCK_RADIUS_MIN_M = 0.15;
const ROCK_RADIUS_MAX_M = 1.25;
const ROCK_SIZE_SKEW = 3; // radius ~ k^skew: mostly small stones, few boulders
const ROCK_JITTER = 0.18; // of the radius, per vertex
const ROCK_SINK = 0.35; // of the radius, centre below the ground
const ROCK_COLLIDER_SCALE = 0.9; // sphere radius vs the mesh's, so dents don't hold the car off
const ROCK_COLORS = [0x6f6a64, 0x807b74, 0x5e5a55, 0x8e8a83].map((c) => new THREE.Color(c));
// Crown colour: this much of the photo, the rest the tree's base green. Canopy photos
// are dark (shadows between crowns), so the photo is brightened first.
const PHOTO_MIX = 0.8;
const PHOTO_GAIN = 1.35;
const TREE_TILT_MAX_RAD = THREE.MathUtils.degToRad(6); // random lean so forests don't look combed
const TREE_FIELDS = 6; // per tree: tile fraction u, v, scale, yaw, crown colour index, width

const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);

function hash(a, b, c) {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1) ^ Math.imul(c, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

function buildTrunkGeometry() {
  const g = new THREE.CylinderGeometry(0.22, 0.32, TRUNK_HEIGHT_M, 3, 1, true);
  g.translate(0, TRUNK_HEIGHT_M / 2 - TRUNK_SINK_M, 0);
  return g;
}

function buildCrownGeometry() {
  // 5 x 3 segments = 20 triangles; smooth normals do the rounding.
  const g = new THREE.SphereGeometry(1, 5, 3);
  g.scale(CROWN_RADIUS_M, CROWN_HALF_HEIGHT_M, CROWN_RADIUS_M);
  g.translate(0, CROWN_CENTER_M, 0);
  return g;
}

function buildBushGeometry() {
  const g = new THREE.SphereGeometry(1, 5, 3);
  g.scale(BUSH_RADIUS_M, BUSH_HALF_HEIGHT_M, BUSH_RADIUS_M);
  g.translate(0, BUSH_CENTER_M, 0);
  return g;
}

function buildRockGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 0).toNonIndexed();
  const pos = g.getAttribute('position');
  // Same displacement for coincident vertices (keyed by rounded position), so faces stay closed.
  const offsets = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    if (!offsets.has(key)) offsets.set(key, 1 + (hash(offsets.size, 7, 13) - 0.5) * 2 * ROCK_JITTER);
    const f = offsets.get(key);
    pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f, pos.getZ(i) * f);
  }
  g.translate(0, -ROCK_SINK, 0);
  g.computeVertexNormals();
  return g;
}

function buildPineGeometry() {
  return mergeGeometries(
    PINE_TIERS.map(([baseY, radius, height]) => new THREE.ConeGeometry(radius, height, 5, 1).translate(0, baseY + height / 2, 0))
  );
}

/** Share of pines (0..1) at `asl` metres and latitude `lat` (see config.js PINE_*). */
function pineShare(asl, lat) {
  const drop = (Math.abs(lat) - PINE_REFERENCE_LAT) * PINE_ASL_PER_DEG_M;
  const start = PINE_MIX_START_ASL_M - drop;
  const only = PINE_ONLY_ASL_M - drop;
  return Math.min(1, Math.max(0, (asl - start) / (only - start)));
}

/** Distance grow-in on an instanced material; `grow` = { value: Vector2(fullDist, goneDist) }. */
function applyDistanceGrow(material, grow) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.treeGrow = grow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 treeGrow;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // Per tree (instance origin = its foot), horizontal like the CPU draw distance.
        vec4 treeOrigin = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        transformed *= smoothstep(treeGrow.y, treeGrow.x, distance(treeOrigin.xz, cameraPosition.xz));`
      );
  };
  material.customProgramCacheKey = () => 'treeDistanceGrow';
}

// Per kind: landcover key it grows on, crown geometry + base colours, trunks and pines;
// scale(k) / width [min, max] = size from a 0..1 hash; solid = rock bodies near the car.
const treeScale = (k) => SCALE_MIN + (SCALE_MAX - SCALE_MIN) * k;
const TREE_KIND = {
  areaKey: 'forest',
  buildCrown: buildCrownGeometry,
  colors: CROWN_COLORS,
  trunks: true,
  pines: true,
  scale: treeScale,
  width: [WIDTH_MIN, WIDTH_MAX],
  tilt: TREE_TILT_MAX_RAD,
};
const BUSH_KIND = { ...TREE_KIND, areaKey: 'scrub', buildCrown: buildBushGeometry, colors: BUSH_COLORS, trunks: false, pines: false, tilt: 0 };
const ROCK_KIND = {
  ...BUSH_KIND,
  areaKey: 'rock',
  buildCrown: buildRockGeometry,
  colors: ROCK_COLORS,
  scale: (k) => ROCK_RADIUS_MIN_M + (ROCK_RADIUS_MAX_M - ROCK_RADIUS_MIN_M) * k ** ROCK_SIZE_SKEW,
  width: [0.85, 1.2],
  flatShading: true,
  solid: true,
};

/** Forest trees; deps as createVegetation. */
export function createTrees(deps) {
  return createVegetation({ ...deps, kind: TREE_KIND });
}

/** Scrub bushes: sparser and nearer than trees; deps as createVegetation. */
export function createBushes(deps) {
  return createVegetation({
    drawDistance: BUSH_DRAW_DISTANCE_M,
    growDistance: BUSH_GROW_M,
    areaPerTree: BUSH_AREA_PER_BUSH_M2,
    gap: BUSH_GAP_M,
    ...deps,
    kind: BUSH_KIND,
  });
}

/** Rocks on rock/scree: bush density, solid near the car (needs deps.world); deps as createVegetation. */
export function createRocks(deps) {
  return createVegetation({
    drawDistance: ROCK_DRAW_DISTANCE_M,
    growDistance: ROCK_GROW_M,
    areaPerTree: ROCK_AREA_PER_ROCK_M2,
    gap: ROCK_GAP_M,
    ...deps,
    kind: ROCK_KIND,
  });
}

/**
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {import('cannon-es').World} [deps.world] - for solid kinds (rocks)
 * @param {import('./terrain.js').TerrainManager} deps.terrain
 * @param {import('./landcoverAreas.js').LandcoverAreasManager} deps.landcoverAreas
 * @param {import('./streets.js').StreetsManager} deps.streets
 * @param {import('./waterAreas.js').WaterAreasManager} [deps.waterAreas]
 * @param {import('./rivers.js').RiversManager} [deps.rivers]
 * @param {ReturnType<import('./dissolve.js').createDissolve>} [deps.dissolve]
 */
function createVegetation({
  kind,
  scene,
  world = null,
  terrain,
  landcoverAreas,
  streets,
  waterAreas = null,
  rivers = null,
  dissolve = null,
  drawDistance: baseDrawDistance = TREE_DRAW_DISTANCE_M,
  trunkDistance = TREE_TRUNK_DISTANCE_M,
  growDistance = TREE_GROW_M,
  areaPerTree: initialAreaPerTree = TREE_AREA_PER_TREE_M2,
  gap = TREE_GAP_M,
  physicsDistance = ROCK_PHYSICS_DISTANCE_M,
}) {
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.9, flatShading: true });
  const crownMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, flatShading: !!kind.flatShading });
  let drawDistance = baseDrawDistance;
  let areaPerTree = initialAreaPerTree;
  const grow = { value: new THREE.Vector2(Math.max(0, drawDistance - growDistance), drawDistance) };
  applyDistanceGrow(trunkMaterial, grow);
  applyDistanceGrow(crownMaterial, grow);
  const sets = [
    { geometry: buildTrunkGeometry(), material: trunkMaterial, mesh: null },
    { geometry: kind.buildCrown(), material: crownMaterial, mesh: null },
    { geometry: buildPineGeometry(), material: crownMaterial, mesh: null },
  ];
  const [trunkSet, crownSet, pineSet] = sets;
  let spacing = Math.sqrt(areaPerTree);
  const tiles = new Map(); // "tx_ty" -> Float32Array of TREE_FIELDS per tree
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const tiltQuaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const photoBytes = [0, 0, 0];
  const photo = new THREE.Color();
  const crownColor = new THREE.Color();
  let visible = true;
  let shadows = false;
  let lastX = Infinity;
  let lastZ = Infinity;
  let sinceRebuild = Infinity;
  let dirty = true;
  let unfilledTiles = 0; // in range, skipped for lack of time (not ones waiting for data)
  const bodies = new Map(); // "tx_ty:i" -> static sphere body (solid kinds, within physicsDistance)
  let nearTrees = new Map(); // "tx_ty:i" -> [x, y, z, scale] drawn within DISSOLVE_NEAR_M at the last rebuild

  /** Static spheres for the solid instances in `wanted` ("tx_ty:i" -> [x, y, z, radius]); drops the rest. */
  function syncBodies(wanted) {
    for (const [key, body] of bodies) {
      if (wanted.has(key)) continue;
      world.removeBody(body);
      bodies.delete(key);
    }
    for (const [key, [bx, by, bz, radius]] of wanted) {
      let body = bodies.get(key);
      if (!body) {
        body = new CANNON.Body({ mass: 0, material: BUILDING_MATERIAL, shape: new CANNON.Sphere(radius) });
        body.collisionFilterGroup = BUILDING_COLLISION_GROUP;
        world.addBody(body);
        bodies.set(key, body);
      }
      body.position.set(bx, by, bz); // also follows refined terrain
      body.aabbNeedsUpdate = true;
    }
  }

  /** Bursts last rebuild's near trees that are gone now (tile dropped or out of draw range, e.g. a teleport). */
  function dissolveDropped(x, z, near) {
    const maxDistSq = drawDistance * drawDistance;
    for (const [key, [px, py, pz, s]] of nearTrees) {
      if (near.has(key)) continue;
      const gone = !tiles.has(key.slice(0, key.indexOf(':'))) || (px - x) ** 2 + (pz - z) ** 2 > maxDistSq;
      if (gone) dissolve.dissolveColumn(px, py, pz, (CROWN_CENTER_M + CROWN_HALF_HEIGHT_M) * s);
    }
    nearTrees = near;
  }

  const toLocal = (lat, lon) => latLonToLocal(lat, lon, landcoverAreas.originLat, landcoverAreas.originLon, landcoverAreas.scaleLat);

  function ensureCapacity(set, count) {
    if (set.mesh ? set.mesh.instanceMatrix.count >= count : count === 0) return; // no mesh until first needed
    let capacity = set.mesh ? set.mesh.instanceMatrix.count : INITIAL_CAPACITY;
    while (capacity < count) capacity *= 2;
    if (set.mesh) {
      scene.remove(set.mesh);
      set.mesh.dispose();
    }
    set.mesh = new THREE.InstancedMesh(set.geometry, set.material, capacity);
    set.mesh.frustumCulled = false; // instances span the whole draw distance around the car
    set.mesh.castShadow = shadows;
    set.mesh.visible = visible;
    set.mesh.count = 0;
    scene.add(set.mesh);
  }

  /** Corners of DETAIL_ZOOM tile (tx, ty) in the current local frame. */
  function tileCorners(tx, ty) {
    const nw = toLocal(tileY2lat(ty, DETAIL_ZOOM), tileX2lon(tx, DETAIL_ZOOM));
    const se = toLocal(tileY2lat(ty + 1, DETAIL_ZOOM), tileX2lon(tx + 1, DETAIL_ZOOM));
    return { nw, se };
  }

  /** Street and river segments near the tile as [ax, az, bx, bz, halfWidth, ...] in the local frame. */
  function lineSegmentsAround(cx, cz, radius) {
    const out = [];
    const segs = [...streets.itemsWithin(cx, cz, radius), ...(rivers?.itemsWithin(cx, cz, radius) ?? [])];
    for (const seg of segs) {
      if (seg.style.brunnel === 'tunnel') continue;
      const a = toLocal(seg.a.lat, seg.a.lon);
      const b = toLocal(seg.b.lat, seg.b.lon);
      out.push(a.x, a.z, b.x, b.z, seg.style.linewidth / 2);
    }
    return out;
  }

  function clearOfLines(x, z, segments) {
    for (let k = 0; k < segments.length; k += 5) {
      const ax = segments[k];
      const az = segments[k + 1];
      const bx = segments[k + 2];
      const bz = segments[k + 3];
      const reach = segments[k + 4] + gap;
      if (x < Math.min(ax, bx) - reach || x > Math.max(ax, bx) + reach) continue;
      if (z < Math.min(az, bz) - reach || z > Math.max(az, bz) + reach) continue;
      const dx = bx - ax;
      const dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lenSq)) : 0;
      if (Math.hypot(x - ax - dx * t, z - az - dz * t) < reach) return false;
    }
    return true;
  }

  /** Trees of tile (tx, ty), or null while a layer they depend on has no data there yet. */
  function placeTile(tx, ty) {
    const lat = tileY2lat(ty + 0.5, DETAIL_ZOOM);
    const lon = tileX2lon(tx + 0.5, DETAIL_ZOOM);
    for (const layer of [landcoverAreas, streets, waterAreas, rivers]) {
      if (layer && !layer.hasDataAt(lat, lon)) return null;
    }
    const { nw, se } = tileCorners(tx, ty);
    const width = se.x - nw.x;
    const height = se.z - nw.z;
    const cols = Math.max(1, Math.round(width / spacing));
    const rows = Math.max(1, Math.round(height / spacing));
    const out = [];
    let segments = null; // gathered on the first candidate in forest
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = r * cols + c;
        const u = (c + 0.5 + (hash(tx, ty, cell * 5) - 0.5) * JITTER) / cols;
        const v = (r + 0.5 + (hash(tx, ty, cell * 5 + 1) - 0.5) * JITTER) / rows;
        const x = nw.x + u * width;
        const z = nw.z + v * height;
        if (landcoverAreas.classifyAt(x, z) !== kind.areaKey) continue;
        if (waterAreas?.isNear(x, z, gap)) continue;
        segments ??= lineSegmentsAround(
          (nw.x + se.x) / 2,
          (nw.z + se.z) / 2,
          Math.max(width, height) / 2 + gap + SEGMENT_SLACK_M
        );
        if (!clearOfLines(x, z, segments)) continue;
        const k = hash(tx, ty, cell * 5 + 2);
        out.push(
          u,
          v,
          kind.scale(k),
          hash(tx, ty, cell * 5 + 3) * Math.PI * 2,
          Math.floor(k * 7919) % kind.colors.length,
          kind.width[0] + (kind.width[1] - kind.width[0]) * hash(tx, ty, cell * 5 + 4)
        );
      }
    }
    return new Float32Array(out);
  }

  /** DETAIL_ZOOM tiles within the draw distance of (x, z), nearest first. */
  function tilesInRange(x, z) {
    const { lat, lon } = localToLatLon(x, z, landcoverAreas.originLat, landcoverAreas.originLon, landcoverAreas.scaleLat);
    const fx = lon2tileX(lon, DETAIL_ZOOM);
    const fy = lat2tileY(lat, DETAIL_ZOOM);
    const tileMeters = tileSizeMeters(DETAIL_ZOOM, lat);
    const reach = drawDistance / tileMeters;
    const out = [];
    for (let ty = Math.floor(fy - reach); ty <= Math.floor(fy + reach); ty++) {
      for (let tx = Math.floor(fx - reach); tx <= Math.floor(fx + reach); tx++) {
        // Nearest point of the tile to the car, in tiles.
        const dx = Math.max(tx - fx, 0, fx - tx - 1);
        const dy = Math.max(ty - fy, 0, fy - ty - 1);
        const distSq = dx * dx + dy * dy;
        if (distSq <= reach * reach) out.push({ tx, ty, key: `${tx}_${ty}`, distSq });
      }
    }
    return out.sort((a, b) => a.distSq - b.distSq);
  }

  /** Places trees on new tiles in range until `deadline` and drops tiles left behind; true if any were placed. */
  function fill(inRange, deadline) {
    let placed = false;
    unfilledTiles = 0;
    for (const { tx, ty, key } of inRange) {
      if (tiles.has(key)) continue;
      if (performance.now() >= deadline) {
        unfilledTiles++;
        continue;
      }
      const trees = placeTile(tx, ty);
      if (!trees) continue;
      tiles.set(key, trees);
      placed = true;
    }
    const keep = new Set(inRange.map(({ key }) => key));
    for (const key of Array.from(tiles.keys())) if (!keep.has(key)) tiles.delete(key);
    return placed;
  }

  function rebuild(x, z, inRange) {
    const maxDistSq = drawDistance * drawDistance;
    const trunkDistSq = trunkDistance * trunkDistance;
    const physicsDistSq = physicsDistance * physicsDistance;
    const nearDistSq = DISSOLVE_NEAR_M * DISSOLVE_NEAR_M;
    const near = new Map();
    const solids = new Map();
    let count = 0;
    let trunkCount = 0;
    let pineCount = 0;
    const instances = []; // [x, y, z, scale, yaw, colour, trunk, width, pine, tilt, ...]
    for (const { tx, ty, key } of inRange) {
      const trees = tiles.get(key);
      if (!trees?.length) continue;
      const { nw, se } = tileCorners(tx, ty);
      const lat = tileY2lat(ty + 0.5, DETAIL_ZOOM);
      for (let i = 0; i < trees.length; i += TREE_FIELDS) {
        const px = nw.x + trees[i] * (se.x - nw.x);
        const pz = nw.z + trees[i + 1] * (se.z - nw.z);
        const distSq = (px - x) ** 2 + (pz - z) ** 2;
        if (distSq > maxDistSq) continue;
        const py = terrain.surfaceHeightAt(px, pz);
        if (py == null) continue; // retried on the next interval rebuild
        const trunk = kind.trunks && distSq <= trunkDistSq;
        // Fixed per tree (its own seed, apart from the placement hashes), compared to the local share.
        const pine = kind.pines && hash(tx, ty ^ 0x5bd1e995, i) < pineShare(py + terrain.heightOffset, lat);
        const tilt = kind.tilt ? kind.tilt * hash(tx, ty ^ 0x2c1b3c6d, i) : 0;
        instances.push(px, py, pz, trees[i + 2], trees[i + 3], trees[i + 4], trunk ? 1 : 0, trees[i + 5], pine ? 1 : 0, tilt);
        count++;
        if (dissolve && distSq <= nearDistSq) near.set(`${key}:${i}`, [px, py, pz, trees[i + 2]]);
        if (trunk) trunkCount++;
        if (pine) pineCount++;
        if (kind.solid && world && distSq <= physicsDistSq) {
          const radius = trees[i + 2];
          solids.set(`${key}:${i}`, [px, py - ROCK_SINK * radius, pz, radius * Math.min(1, trees[i + 5]) * ROCK_COLLIDER_SCALE]);
        }
      }
    }
    if (kind.solid && world) syncBodies(solids);
    if (dissolve) dissolveDropped(x, z, near);
    ensureCapacity(trunkSet, trunkCount);
    ensureCapacity(crownSet, count - pineCount);
    ensureCapacity(pineSet, pineCount);
    for (const [set, n] of [[trunkSet, trunkCount], [crownSet, count - pineCount], [pineSet, pineCount]]) {
      if (!set.mesh) continue;
      set.mesh.position.set(0, 0, 0);
      set.mesh.count = n;
    }
    let trunkIndex = 0;
    let crownIndex = 0;
    let pineIndex = 0;
    for (let n = 0; n < count; n++) {
      const j = n * 10;
      const pine = instances[j + 8];
      const crowns = pine ? pineSet : crownSet;
      const index = pine ? pineIndex++ : crownIndex++;
      const s = instances[j + 3];
      position.set(instances[j], instances[j + 1], instances[j + 2]);
      // Lean about the tree's own x axis; the random yaw makes the direction random.
      quaternion.setFromAxisAngle(UP, instances[j + 4]).multiply(tiltQuaternion.setFromAxisAngle(SIDE, instances[j + 9]));
      const w = s * instances[j + 7];
      scale.set(w, s, w);
      matrix.compose(position, quaternion, scale);
      crowns.mesh.setMatrixAt(index, matrix);
      crownColor.copy((pine ? PINE_COLORS : kind.colors)[instances[j + 5]]);
      if (terrain.groundColorAt(instances[j], instances[j + 2], photoBytes)) {
        const k = PHOTO_GAIN / 255;
        photo.setRGB(Math.min(1, photoBytes[0] * k), Math.min(1, photoBytes[1] * k), Math.min(1, photoBytes[2] * k), THREE.SRGBColorSpace);
        crownColor.lerp(photo, PHOTO_MIX);
      }
      crowns.mesh.setColorAt(index, crownColor);
      if (instances[j + 6]) trunkSet.mesh.setMatrixAt(trunkIndex++, matrix);
    }
    for (const set of sets) if (set.mesh) set.mesh.instanceMatrix.needsUpdate = true;
    for (const set of [crownSet, pineSet]) if (set.mesh?.instanceColor) set.mesh.instanceColor.needsUpdate = true;
  }

  return {
    /** Call once per frame with the car's world position; places new trees until `deadline`. */
    update(dt, x, z, deadline = Infinity) {
      if (!visible) return;
      sinceRebuild += dt;
      const moved = Math.hypot(x - lastX, z - lastZ) >= REBUILD_MOVE_M;
      if (!dirty && !moved && sinceRebuild < REBUILD_INTERVAL_S) return;
      const inRange = tilesInRange(x, z);
      const placed = fill(inRange, deadline);
      // Placing is time-sliced: keep filling every frame until nothing's left to place.
      dirty = inRange.some(({ key }) => !tiles.has(key)) && (placed || performance.now() >= deadline);
      if (!moved && sinceRebuild < (placed ? FILL_REBUILD_S : REBUILD_INTERVAL_S)) return;
      lastX = x;
      lastZ = z;
      sinceRebuild = 0;
      rebuild(x, z, inRange);
    },

    /** Streaming indicator: in-range tiles still to place. */
    pendingWork() {
      return { downloads: 0, builds: visible ? unfilledTiles : 0 };
    },

    /** Graphics detail: draw distance (grow-in scales with it) and m² per item; a new density re-places every tile. */
    setDetail({ drawDistance: distance, areaPerItem }) {
      drawDistance = distance;
      grow.value.set(Math.max(0, drawDistance - growDistance * (distance / baseDrawDistance)), drawDistance);
      if (areaPerItem !== areaPerTree) {
        areaPerTree = areaPerItem;
        spacing = Math.sqrt(areaPerTree);
        tiles.clear();
        nearTrees = new Map(); // no dissolve burst for trees that are only being re-placed
      }
      dirty = true;
      sinceRebuild = Infinity;
    },

    /** Debug HUD: drawn instances (one per crown). */
    getCount() {
      return visible ? (crownSet.mesh?.count ?? 0) + (pineSet.mesh?.count ?? 0) : 0;
    },

    setVisible(value) {
      visible = value;
      if (!value && world) syncBodies(new Map()); // hidden rocks don't collide; the next rebuild restores them
      for (const set of sets) if (set.mesh) set.mesh.visible = value;
      sinceRebuild = Infinity;
    },

    setShadows(value) {
      shadows = value;
      for (const set of sets) if (set.mesh) set.mesh.castShadow = value;
    },

    /** Meshes are moved by the generic shift; the next rebuild re-bases the instances. */
    shiftOrigin(dx, dz) {
      lastX -= dx;
      lastZ -= dz;
      for (const tree of nearTrees.values()) {
        tree[0] -= dx;
        tree[2] -= dz;
      }
    },
  };
}
