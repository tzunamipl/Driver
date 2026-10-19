// Forest trees: super-low-poly instances (3-sided trunk + smooth-shaded blob crown, trunks
// only within `trunkDistance`) on a jittered
// grid inside forestAreas.js polygons, kept `gap` clear of every street
// line's edge (tunnels aside), river strips and water areas. Visual only - no bodies; no
// shadows unless setShadows() turns them on (debug).
// Trees are placed per DETAIL_ZOOM tile, as fractions of the tile (survive
// origin shifts), once every layer they're checked against has its data there.
// Crowns blend their base green with the aerial photo under them (terrain.groundColorAt).
// Far trees fade in with a dither (discarded pixels), so they stay opaque: no sorting or overdraw.

import * as THREE from 'three';
import { latLonToLocal, localToLatLon, lon2tileX, lat2tileY, tileX2lon, tileY2lat, tileSizeMeters } from './geo.js';
import { DETAIL_ZOOM } from './terrain.js';
import { TREE_AREA_PER_TREE_M2, TREE_DRAW_DISTANCE_M, TREE_FADE_M, TREE_GAP_M, TREE_TRUNK_DISTANCE_M } from '../config.js';

const REBUILD_MOVE_M = 20;
const REBUILD_INTERVAL_S = 1; // also picks up refined terrain
const FILL_REBUILD_S = 0.2; // newly placed tiles show at most this often
const FILL_BUDGET_MS = 2; // per frame, for placing trees on newly seen tiles
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
const CROWN_COLORS = [0x2f5d24, 0x3d7a2a, 0x24491c, 0x4a7f30].map((c) => new THREE.Color(c));
// Crown colour: this much of the photo, the rest the tree's base green. Canopy photos
// are dark (shadows between crowns), so the photo is brightened first.
const PHOTO_MIX = 0.8;
const PHOTO_GAIN = 1.35;
const TREE_FIELDS = 6; // per tree: tile fraction u, v, scale, yaw, crown colour index, width

const UP = new THREE.Vector3(0, 1, 0);

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

/** Dithered distance fade on an instanced material; `fade` = { value: Vector2(solidDist, goneDist) }. */
function applyDitherFade(material, fade) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.treeFade = fade;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 treeFade;\nvarying float vTreeFade;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        // Per tree (instance origin), horizontal like the CPU draw distance.
        vec4 treeOrigin = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vTreeFade = clamp((treeFade.y - distance(treeOrigin.xz, cameraPosition.xz)) / (treeFade.y - treeFade.x), 0.0, 1.0);`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vTreeFade;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        // Interleaved gradient noise: a fine screen-space threshold pattern.
        if (vTreeFade < 1.0 && vTreeFade <= fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))) discard;`
      );
  };
  material.customProgramCacheKey = () => 'treeDitherFade';
}

/**
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {import('./terrain.js').TerrainManager} deps.terrain
 * @param {import('./forestAreas.js').ForestAreasManager} deps.forestAreas
 * @param {import('./streets.js').StreetsManager} deps.streets
 * @param {import('./waterAreas.js').WaterAreasManager} [deps.waterAreas]
 * @param {import('./rivers.js').RiversManager} [deps.rivers]
 */
export function createTrees({
  scene,
  terrain,
  forestAreas,
  streets,
  waterAreas = null,
  rivers = null,
  drawDistance = TREE_DRAW_DISTANCE_M,
  trunkDistance = TREE_TRUNK_DISTANCE_M,
  fadeDistance = TREE_FADE_M,
  areaPerTree = TREE_AREA_PER_TREE_M2,
  gap = TREE_GAP_M,
}) {
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.9, flatShading: true });
  const crownMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
  const fade = { value: new THREE.Vector2(Math.max(0, drawDistance - fadeDistance), drawDistance) };
  applyDitherFade(trunkMaterial, fade);
  applyDitherFade(crownMaterial, fade);
  const sets = [
    { geometry: buildTrunkGeometry(), material: trunkMaterial, mesh: null },
    { geometry: buildCrownGeometry(), material: crownMaterial, mesh: null },
  ];
  const [trunkSet, crownSet] = sets;
  const spacing = Math.sqrt(areaPerTree);
  const tiles = new Map(); // "tx_ty" -> Float32Array of TREE_FIELDS per tree
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
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

  const toLocal = (lat, lon) => latLonToLocal(lat, lon, forestAreas.originLat, forestAreas.originLon, forestAreas.scaleLat);

  function ensureCapacity(set, count) {
    if (set.mesh && set.mesh.instanceMatrix.count >= count) return;
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
    for (const layer of [forestAreas, streets, waterAreas, rivers]) {
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
        if (!forestAreas.classifyAt(x, z)) continue;
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
          SCALE_MIN + (SCALE_MAX - SCALE_MIN) * k,
          hash(tx, ty, cell * 5 + 3) * Math.PI * 2,
          Math.floor(k * 7919) % CROWN_COLORS.length,
          WIDTH_MIN + (WIDTH_MAX - WIDTH_MIN) * hash(tx, ty, cell * 5 + 4)
        );
      }
    }
    return new Float32Array(out);
  }

  /** DETAIL_ZOOM tiles within the draw distance of (x, z), nearest first. */
  function tilesInRange(x, z) {
    const { lat, lon } = localToLatLon(x, z, forestAreas.originLat, forestAreas.originLon, forestAreas.scaleLat);
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

  /** Places trees on new tiles in range (time-sliced) and drops tiles left behind; true if any were placed. */
  function fill(inRange) {
    const deadline = performance.now() + FILL_BUDGET_MS;
    let placed = false;
    for (const { tx, ty, key } of inRange) {
      if (tiles.has(key)) continue;
      if (performance.now() >= deadline) break;
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
    let count = 0;
    let trunkCount = 0;
    const instances = []; // [x, y, z, scale, yaw, colour, trunk, width, ...]
    for (const { tx, ty, key } of inRange) {
      const trees = tiles.get(key);
      if (!trees?.length) continue;
      const { nw, se } = tileCorners(tx, ty);
      for (let i = 0; i < trees.length; i += TREE_FIELDS) {
        const px = nw.x + trees[i] * (se.x - nw.x);
        const pz = nw.z + trees[i + 1] * (se.z - nw.z);
        const distSq = (px - x) ** 2 + (pz - z) ** 2;
        if (distSq > maxDistSq) continue;
        const py = terrain.surfaceHeightAt(px, pz);
        if (py == null) continue; // retried on the next interval rebuild
        const trunk = distSq <= trunkDistSq;
        instances.push(px, py, pz, trees[i + 2], trees[i + 3], trees[i + 4], trunk ? 1 : 0, trees[i + 5]);
        count++;
        if (trunk) trunkCount++;
      }
    }
    ensureCapacity(trunkSet, trunkCount);
    ensureCapacity(crownSet, count);
    for (const set of sets) set.mesh.position.set(0, 0, 0);
    trunkSet.mesh.count = trunkCount;
    crownSet.mesh.count = count;
    let trunkIndex = 0;
    for (let n = 0; n < count; n++) {
      const j = n * 8;
      const s = instances[j + 3];
      position.set(instances[j], instances[j + 1], instances[j + 2]);
      quaternion.setFromAxisAngle(UP, instances[j + 4]);
      const w = s * instances[j + 7];
      scale.set(w, s, w);
      matrix.compose(position, quaternion, scale);
      crownSet.mesh.setMatrixAt(n, matrix);
      crownColor.copy(CROWN_COLORS[instances[j + 5]]);
      if (terrain.groundColorAt(instances[j], instances[j + 2], photoBytes)) {
        const k = PHOTO_GAIN / 255;
        photo.setRGB(Math.min(1, photoBytes[0] * k), Math.min(1, photoBytes[1] * k), Math.min(1, photoBytes[2] * k), THREE.SRGBColorSpace);
        crownColor.lerp(photo, PHOTO_MIX);
      }
      crownSet.mesh.setColorAt(n, crownColor);
      if (instances[j + 6]) trunkSet.mesh.setMatrixAt(trunkIndex++, matrix);
    }
    for (const set of sets) set.mesh.instanceMatrix.needsUpdate = true;
    if (crownSet.mesh.instanceColor) crownSet.mesh.instanceColor.needsUpdate = true;
  }

  return {
    /** Call once per frame with the car's world position. */
    update(dt, x, z) {
      if (!visible) return;
      sinceRebuild += dt;
      const moved = Math.hypot(x - lastX, z - lastZ) >= REBUILD_MOVE_M;
      if (!dirty && !moved && sinceRebuild < REBUILD_INTERVAL_S) return;
      const inRange = tilesInRange(x, z);
      const placed = fill(inRange);
      // Placing is time-sliced: keep filling every frame until nothing's left to place.
      dirty = inRange.some(({ key }) => !tiles.has(key)) && placed;
      if (!moved && sinceRebuild < (placed ? FILL_REBUILD_S : REBUILD_INTERVAL_S)) return;
      lastX = x;
      lastZ = z;
      sinceRebuild = 0;
      rebuild(x, z, inRange);
    },

    setVisible(value) {
      visible = value;
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
    },
  };
}
