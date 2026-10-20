// 3D buildings from OpenFreeMap vector tiles (static CDN files; more
// reliable than the overloaded public Overpass servers). The `building`
// layer already carries render_height. Tiles come at BUILDING_TILE_ZOOM
// (14) and are bucketed by centroid into DETAIL_ZOOM (20) tiles, streamed
// on the terrain detail grid. Decoded tiles are written to IndexedDB
// (buildingsCache.js) as an offline fallback. Past them, buildings/
// farBuildings.js draws every footprint as a plain box.
// Limitations: outer ring only, flat roofs.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { latLonToLocal } from './geo.js';
import { cacheTiles, readCachedRegion } from './buildingsCache.js';
import {
  BUILDING_TILE_ZOOM,
  MIN_FOOTPRINT_POINTS,
  MAX_FOOTPRINT_METERS,
  fetchBuildingFeatures,
  convexHull2D,
} from './buildings/features.js';
import { FarBuildingsManager } from './buildings/farBuildings.js';
import {
  DETAIL_ZOOM,
  DETAIL_BOX,
  DETAIL_RADIUS,
  UNLOAD_MARGIN,
  UNLOAD_DELAY_TICKS,
  inCircle,
  GROUND_COLLISION_GROUP,
} from './terrain.js';

// Separate from GROUND_COLLISION_GROUP so ground raycasts ignore roofs.
export const BUILDING_COLLISION_GROUP = 4;
// Paired with CHASSIS_MATERIAL in physicsSetup.js (low friction, so the
// car slides along walls instead of snagging).
export const BUILDING_MATERIAL = new CANNON.Material('building');

// Physics prism extends this far below the lowest ground sample, so slopes
// and tile seams never leave a gap to drive under.
const BUILDING_SKIRT_DEPTH_M = 4;

const BUILDING_COLOR = 0xb8b0a4;
const DEFAULT_BUILDING_COLOR = new THREE.Color(BUILDING_COLOR);
const _vertexColorScratch = new THREE.Color();

const BUILD_TIME_CHECK_INTERVAL = 4; // buildings between clock checks

const REGION_MARGIN_TILES = 2; // extra tiles fetched beyond the keep radius
const REGION_RETRY_COOLDOWN_MS = 8000;
// Every DETAIL_ZOOM tile the terrain streams (the full DETAIL_BOX square, LOW corners included), nearest first.
const BUILD_OFFSETS = [];
for (let dy = -DETAIL_BOX; dy <= DETAIL_BOX; dy++) {
  for (let dx = -DETAIL_BOX; dx <= DETAIL_BOX; dx++) BUILD_OFFSETS.push({ dx, dy });
}
BUILD_OFFSETS.sort((a, b) => a.dx * a.dx + a.dy * a.dy - (b.dx * b.dx + b.dy * b.dy));

function inSquare(dx, dy, radius) {
  return Math.abs(dx) <= radius && Math.abs(dy) <= radius;
}

function shiftBody(body, dx, dz) {
  for (const v of [body.position, body.previousPosition, body.interpolatedPosition, body.initPosition]) {
    v.x -= dx;
    v.z -= dz;
  }
  body.aabbNeedsUpdate = true;
}

const TILE_ZOOM_RATIO = 2 ** (DETAIL_ZOOM - BUILDING_TILE_ZOOM);

/** Fetches one z14 tile; returns detail-tile key -> [{ ring: [{lat, lon}], height, color }]. */
async function fetchBuildingTile(tx14, ty14) {
  const byTile = new Map();
  for (const { ring, height, color, detailTx, detailTy } of await fetchBuildingFeatures(tx14, ty14)) {
    const key = `${detailTx}_${detailTy}`;
    let list = byTile.get(key);
    if (!list) {
      list = [];
      byTile.set(key, list);
    }
    list.push({ ring, height, color });
  }
  return byTile;
}

/** Rough memory estimate for the debug HUD. */
/** Edges of every body's ConvexPolyhedron in world space, as one LineSegments geometry. */
function buildHitboxGeometry(bodies) {
  const positions = [];
  const seen = new Set();
  for (const body of bodies) {
    const { vertices, faces } = body.shapes[0];
    const { x, y, z } = body.position;
    seen.clear();
    for (const face of faces) {
      for (let i = 0; i < face.length; i++) {
        const a = Math.min(face[i], face[(i + 1) % face.length]);
        const b = Math.max(face[i], face[(i + 1) % face.length]);
        const edge = a * 65536 + b;
        if (seen.has(edge)) continue;
        seen.add(edge);
        const va = vertices[a];
        const vb = vertices[b];
        positions.push(x + va.x, y + va.y, z + va.z, x + vb.x, y + vb.y, z + vb.z);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function estimateTileBytes(mergedGeometry, bodyCount) {
  const position = mergedGeometry?.attributes?.position;
  const vertexBytes = position ? position.array.length * 2 * 4 : 0; // position + normal, 4 bytes/float
  const bodyBytes = bodyCount * 200; // rough flat estimate per CANNON.Box body
  return vertexBytes + bodyBytes;
}

/** ConvexPolyhedron prism over `hull`, centred on `center`, ±halfHeight in y. */
function buildFootprintPrism(hull, center, halfHeight) {
  const n = hull.length;
  const vertices = [];
  const sideFaces = [];
  const bottomFace = [];
  const topFace = [];
  for (let i = 0; i < n; i++) {
    const p = hull[i];
    vertices.push(new CANNON.Vec3(p.x - center.x, -halfHeight, p.z - center.z));
    bottomFace.push(2 * i);
    vertices.push(new CANNON.Vec3(p.x - center.x, halfHeight, p.z - center.z));
    topFace.push(2 * i + 1);
    const j = (i + 1) % n;
    sideFaces.push([2 * i, 2 * i + 1, 2 * j + 1, 2 * j]);
  }
  const faces = [...sideFaces, bottomFace, topFace.slice().reverse()];
  return new CANNON.ConvexPolyhedron({ vertices, faces });
}

/**
 * Extruded flat-roofed mesh (y 0..height) for a local {x, z} footprint,
 * plus its convex hull and AABB; null if degenerate. The shape is built in
 * (x, -z) and rotated -90deg about X so x/z land back in place, y is up.
 */
function buildFootprintGeometry(points, height) {
  if (points.length < MIN_FOOTPRINT_POINTS) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  if (!(spanX > 0) || !(spanZ > 0) || spanX > MAX_FOOTPRINT_METERS || spanZ > MAX_FOOTPRINT_METERS) {
    return null;
  }

  const shape = new THREE.Shape();
  points.forEach((p, i) => {
    if (i === 0) shape.moveTo(p.x, -p.z);
    else shape.lineTo(p.x, -p.z);
  });

  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1 });
  geometry.rotateX(-Math.PI / 2);
  geometry.computeVertexNormals();

  const hull = convexHull2D(points);
  if (hull.length < 3) return null;

  return {
    geometry,
    hull,
    aabb: {
      centerX: (minX + maxX) / 2,
      centerZ: (minZ + maxZ) / 2,
      halfX: Math.max(0.5, spanX / 2),
      halfZ: Math.max(0.5, spanZ / 2),
    },
  };
}

/** Streams building meshes + physics per detail tile from a buffered fetched region. */
const _roofRayFrom = new CANNON.Vec3();
const _roofRayTo = new CANNON.Vec3();
const _roofRayResult = new CANNON.RaycastResult();

export class BuildingsManager {
  constructor(scene, world, originLat, originLon, terrain) {
    this.scene = scene;
    this.world = world;
    this.originLat = originLat;
    this.originLon = originLon;
    this.scaleLat = originLat; // see geo.js; kept by shiftOrigin()
    // Tiles wait for their terrain tile: ground height comes from its heightfield.
    this.terrain = terrain;
    this.chunks = new Map(); // key -> { mesh, bodies[], hitboxLines[], tx, ty, bytes, physics }
    this.pendingRemoval = new Map();
    this.stats = { created: 0, removed: 0, buildings: 0 };
    this._buildQueue = []; // [{ tx, ty, key }] not yet started
    this._queuedKeys = new Set();
    this._inProgressBuilds = new Map(); // key -> build paused mid-tile
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true, // per-building colour baked into the merged geometry
      roughness: 0.9,
      side: THREE.DoubleSide, // OSM winding isn't consistent
    });
    // Debug hitbox wireframes as an x-ray pair sharing geometry: bright
    // where visible (normal depth test), dark where occluded (GreaterDepth).
    // Built per chunk only while shown: idle scene objects still cost a matrix update per frame.
    this._hitboxMaterial = new THREE.LineBasicMaterial({
      color: 0xff33ff,
      depthWrite: false,
    });
    this._hitboxMaterialOccluded = new THREE.LineBasicMaterial({
      color: 0x660066,
      depthTest: true,
      depthFunc: THREE.GreaterDepth,
      depthWrite: false,
    });
    this._hitboxesVisible = false;

    this._region = null; // { minTx, maxTx, minTy, maxTy } of the fetched area
    this._buildingsByTile = new Map(); // tileKey -> [{ ring: [{lat,lon}], height, color }]
    this._regionPending = null;
    this._regionFailedAt = 0;
    this._lastError = null;
    this._usingCachedData = false; // region came from IndexedDB fallback (shown in HUD)
    this._generation = 0; // bumped on recenter() to discard stale fetches
    this._far = new FarBuildingsManager(scene, terrain, originLat, originLon);
  }

  _key(tx, ty) {
    return `${tx}_${ty}`;
  }

  _keepRadius() {
    return DETAIL_BOX + UNLOAD_MARGIN;
  }

  /** True if the current region covers keepRadius tiles around the centre. */
  _regionCovers(centerTx, centerTy) {
    const r = this._keepRadius();
    const region = this._region;
    return (
      !!region &&
      centerTx - r >= region.minTx &&
      centerTx + r <= region.maxTx &&
      centerTy - r >= region.minTy &&
      centerTy + r <= region.maxTy
    );
  }

  /**
   * Fetches a buffered region around the centre if needed. Safe every
   * frame: coalesces concurrent calls, backs off after failure (falling back
   * to cache), and keeps retrying live while on cached data.
   */
  async _ensureRegion(centerTx, centerTy) {
    const covered = this._regionCovers(centerTx, centerTy);
    if (covered && !this._usingCachedData) return;
    if (this._regionPending) {
      await this._regionPending.catch(() => {});
      if (this._regionCovers(centerTx, centerTy) && !this._usingCachedData) return;
    }
    if (this._regionFailedAt && Date.now() - this._regionFailedAt < REGION_RETRY_COOLDOWN_MS) return;

    const r = this._keepRadius() + REGION_MARGIN_TILES;
    const region = {
      minTx: centerTx - r,
      maxTx: centerTx + r,
      minTy: centerTy - r,
      maxTy: centerTy + r,
    };
    const generation = this._generation;
    const promise = this._fetchRegion(region, generation);
    this._regionPending = promise;
    try {
      await promise;
      this._regionFailedAt = 0;
      this._lastError = null;
      this._usingCachedData = false;
    } catch (err) {
      console.warn('Buildings region fetch failed, will retry shortly', err);
      this._regionFailedAt = Date.now();
      this._lastError = err?.message || String(err);
      if (generation === this._generation) await this._fallBackToCache(region, generation);
    } finally {
      if (this._regionPending === promise) this._regionPending = null;
    }
  }

  async _fetchRegion(region, generation) {
    const minTx14 = Math.floor(region.minTx / TILE_ZOOM_RATIO);
    const maxTx14 = Math.floor(region.maxTx / TILE_ZOOM_RATIO);
    const minTy14 = Math.floor(region.minTy / TILE_ZOOM_RATIO);
    const maxTy14 = Math.floor(region.maxTy / TILE_ZOOM_RATIO);

    const tileCoords = [];
    for (let tx14 = minTx14; tx14 <= maxTx14; tx14++) {
      for (let ty14 = minTy14; ty14 <= maxTy14; ty14++) {
        tileCoords.push([tx14, ty14]);
      }
    }

    const results = await Promise.allSettled(tileCoords.map(([tx14, ty14]) => fetchBuildingTile(tx14, ty14)));
    if (generation !== this._generation) return; // recentered meanwhile

    const byTile = new Map();
    let total = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === 'rejected') {
        failed++;
        continue;
      }
      for (const [key, list] of result.value) {
        let existing = byTile.get(key);
        if (!existing) {
          existing = [];
          byTile.set(key, existing);
        }
        existing.push(...list);
        total += list.length;
      }
    }

    // Only a total failure counts (triggers the cache fallback).
    if (tileCoords.length > 0 && failed === tileCoords.length) {
      throw new Error(`All ${failed} building tile request(s) failed`);
    }

    this._region = region;
    this._buildingsByTile = byTile;
    console.info(
      `Buildings region tx[${region.minTx}..${region.maxTx}] ty[${region.minTy}..${region.maxTy}]: ` +
        `${total} buildings bucketed into ${byTile.size} tiles from ${tileCoords.length - failed}/${tileCoords.length} ` +
        `tile request(s)${failed ? `, ${failed} failed` : ''}`
    );

    cacheTiles(DETAIL_ZOOM, byTile).catch(() => {}); // fire-and-forget write-through
  }

  /** After a total fetch failure: use cached tiles for the region, if any (marks data as stale). */
  async _fallBackToCache(region, generation) {
    const cached = await readCachedRegion(DETAIL_ZOOM, region.minTx, region.maxTx, region.minTy, region.maxTy);
    if (generation !== this._generation) return; // recentered meanwhile
    if (cached.size === 0) return; // nothing cached; network retry later

    this._region = region;
    this._buildingsByTile = cached;
    this._usingCachedData = true;
    console.info(
      `Buildings: network fetch failed, using ${cached.size} cached tile(s) for region ` +
        `tx[${region.minTx}..${region.maxTx}] ty[${region.minTy}..${region.maxTy}]`
    );
  }


  /** Terrain height at (x, z) from the detail heightfield, else a ground raycast; null if neither. */
  _groundHeightAt(x, z) {
    const y = this.terrain?.detailHeightAt(x, z);
    if (y != null) return y;
    const from = new CANNON.Vec3(x, 2000, z);
    const to = new CANNON.Vec3(x, -2000, z);
    const result = new CANNON.RaycastResult();
    this.world.raycastClosest(from, to, { collisionFilterMask: GROUND_COLLISION_GROUP }, result);
    return result.hasHit ? result.hitPointWorld.y : null;
  }

  /** Roof height at (x, z) from the building hitboxes (physics circle only); null if no building there. */
  roofHeightAt(x, z) {
    _roofRayFrom.set(x, 2000, z);
    _roofRayTo.set(x, -2000, z);
    _roofRayResult.reset();
    this.world.raycastClosest(_roofRayFrom, _roofRayTo, { collisionFilterMask: BUILDING_COLLISION_GROUP }, _roofRayResult);
    return _roofRayResult.hasHit ? _roofRayResult.hitPointWorld.y : null;
  }

  /** Lowest ground under the hull corners/centre - bottom of the physics prism only. */
  _minGroundHeightAt(hull, centerX, centerZ, centerGroundY) {
    let min = centerGroundY;
    for (const p of hull) {
      const y = this._groundHeightAt(p.x, p.z);
      if (y != null && y < min) min = y; // corners over unloaded terrain are skipped
    }
    return min;
  }

  /** Resumable build descriptor for one tile (from the fetched region, no I/O). */
  _beginChunkBuild(tx, ty) {
    const key = this._key(tx, ty);
    return {
      tx,
      ty,
      key,
      list: this._buildingsByTile.get(key) || [],
      index: 0,
      geometries: [],
      bodies: [],
      skipped: 0,
    };
  }

  /** Builds buildings until done (true) or past `deadline` (false; resume next frame). */
  _stepChunkBuild(build, deadline) {
    const { list } = build;
    let sinceCheck = 0;
    while (build.index < list.length) {
      if (sinceCheck >= BUILD_TIME_CHECK_INTERVAL) {
        if (performance.now() >= deadline) return false;
        sinceCheck = 0;
      }
      sinceCheck++;
      const entry = list[build.index++];
      try {
        const points = entry.ring.map((p) => latLonToLocal(p.lat, p.lon, this.originLat, this.originLon, this.scaleLat));
        const built = buildFootprintGeometry(points, entry.height);
        if (!built) continue;

        // The AABB centre can sit over a neighbour not loaded yet; the vertex mean is in this (loaded) tile.
        const groundY =
          this._groundHeightAt(built.aabb.centerX, built.aabb.centerZ) ??
          this._groundHeightAt(points.reduce((s, p) => s + p.x, 0) / points.length, points.reduce((s, p) => s + p.z, 0) / points.length) ??
          0;
        const center = { x: built.aabb.centerX, z: built.aabb.centerZ };
        // Roof at centre ground + height (matches the mesh); bottom below
        // the lowest ground sample plus a skirt.
        const topY = groundY + entry.height;
        const bottomY = this._minGroundHeightAt(built.hull, center.x, center.z, groundY) - BUILDING_SKIRT_DEPTH_M;
        const physicsHalfHeight = (topY - bottomY) / 2;
        const physicsCenterY = (topY + bottomY) / 2;
        const body = new CANNON.Body({ mass: 0, material: BUILDING_MATERIAL });
        body.collisionFilterGroup = BUILDING_COLLISION_GROUP;
        body.addShape(buildFootprintPrism(built.hull, center, physicsHalfHeight));
        body.position.set(center.x, physicsCenterY, center.z);
        build.bodies.push(body); // added to the world by _syncChunkPhysics

        built.geometry.translate(0, groundY, 0);

        // Per-vertex colour (tiles are merged into one mesh). `color` is
        // missing only in caches written before it existed.
        const buildingColor = entry.color == null ? DEFAULT_BUILDING_COLOR : _vertexColorScratch.setHex(entry.color);
        const vertexCount = built.geometry.attributes.position.count;
        const colorArray = new Float32Array(vertexCount * 3);
        for (let v = 0; v < vertexCount; v++) {
          colorArray[v * 3] = buildingColor.r;
          colorArray[v * 3 + 1] = buildingColor.g;
          colorArray[v * 3 + 2] = buildingColor.b;
        }
        built.geometry.setAttribute('color', new THREE.BufferAttribute(colorArray, 3));

        build.geometries.push(built.geometry);
      } catch (err) {
        build.skipped++;
        console.warn('Skipping one malformed building footprint', build.tx, build.ty, err);
      }
    }
    return true;
  }

  /** Merges a finished build into one mesh and registers the chunk. */
  _finishChunkBuild(build) {
    const { tx, ty, key, geometries, bodies, skipped } = build;
    let mesh = null;
    if (geometries.length) {
      const merged = mergeGeometries(geometries, false);
      mesh = new THREE.Mesh(merged, this.material);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.scene.add(mesh);
      for (const g of geometries) g.dispose();
    }
    if (skipped) console.warn(`Buildings tile ${tx},${ty}: ${skipped} malformed footprints skipped`);

    const bytes = estimateTileBytes(mesh?.geometry, bodies.length);
    const chunk = { mesh, bodies, hitboxLines: [], tx, ty, bytes, physics: false };
    this.chunks.set(key, chunk);
    this._syncChunkPhysics(chunk);
    this.stats.created++;
    this.stats.buildings += bodies.length;
  }

  /** Removes the partial bodies/meshes of a build paused mid-tile. */
  _abandonChunkBuild(build) {
    for (const g of build.geometries) g.dispose();
  }

  /** Pending work for the streaming indicator: tile builds and far tiles, plus one for a region fetch. */
  pendingWork() {
    const far = this._far.pendingWork();
    return {
      downloads: (this._regionPending ? 1 : 0) + far.downloads,
      builds: this._buildQueue.length + this._inProgressBuilds.size + far.builds,
    };
  }

  /** True once a tile is built (not just fetched) - for the debug stats HUD. */
  isTileLoaded(tx, ty) {
    return this.chunks.has(this._key(tx, ty));
  }

  _unloadChunk(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    if (chunk.mesh) {
      this.scene.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
    }
    if (chunk.physics) for (const body of chunk.bodies) this.world.removeBody(body);
    this._syncChunkHitboxes(chunk, false);
    this.stats.buildings -= chunk.bodies.length;
    this.chunks.delete(key);
    this.pendingRemoval.delete(key);
    this.stats.removed++;
  }

  /** M-key debug toggle for hitbox wireframes. */
  setHitboxesVisible(visible) {
    this._hitboxesVisible = visible;
    for (const chunk of this.chunks.values()) this._syncChunkHitboxes(chunk, visible && chunk.physics);
  }

  /** Creates or drops a chunk's hitbox wireframe pair. */
  _syncChunkHitboxes(chunk, want) {
    if (want === chunk.hitboxLines.length > 0) return;
    if (want) {
      if (!chunk.bodies.length) return;
      // Bodies are in world space; the lines sit at the origin and follow floating-origin shifts as scene children.
      const geometry = buildHitboxGeometry(chunk.bodies);
      for (const material of [this._hitboxMaterial, this._hitboxMaterialOccluded]) {
        const lines = new THREE.LineSegments(geometry, material);
        lines.renderOrder = 999;
        this.scene.add(lines);
        chunk.hitboxLines.push(lines);
      }
    } else {
      for (const lines of chunk.hitboxLines) this.scene.remove(lines);
      chunk.hitboxLines[0].geometry.dispose(); // the pair shares one geometry
      chunk.hitboxLines = [];
    }
  }

  /** Collision only on the terrain's physics circle; LOW tiles are visual only. */
  _syncChunkPhysics(chunk) {
    const want = inCircle(chunk.tx - this._centerTx, chunk.ty - this._centerTy, DETAIL_RADIUS);
    if (want === chunk.physics) return;
    chunk.physics = want;
    for (const body of chunk.bodies) {
      if (want) this.world.addBody(body);
      else this.world.removeBody(body);
    }
    this._syncChunkHitboxes(chunk, this._hitboxesVisible && want);
  }

  /** Drops everything (incl. in-progress builds and region) for a new origin. */
  recenter(lat, lon) {
    for (const key of Array.from(this.chunks.keys())) this._unloadChunk(key);
    this.pendingRemoval.clear();
    for (const build of this._inProgressBuilds.values()) this._abandonChunkBuild(build);
    this._inProgressBuilds.clear();
    this._buildQueue = [];
    this._queuedKeys.clear();
    this._region = null;
    this._buildingsByTile = new Map();
    this._regionPending = null;
    this._regionFailedAt = 0;
    this._lastError = null;
    this._usingCachedData = false;
    this._generation++;
    this.originLat = lat;
    this.originLon = lon;
    this.scaleLat = lat;
    this._far.recenter(lat, lon);
  }

  /**
   * Floating-origin shift by (dx, dz): scene objects and bodies were already
   * translated by the caller; partial builds' geometry (not in the scene yet)
   * and bodies not in the world are moved here.
   */
  shiftOrigin(lat, lon, dx, dz) {
    this.originLat = lat;
    this.originLon = lon;
    this._far.shiftOrigin(lat, lon, dx, dz);
    for (const build of this._inProgressBuilds.values()) {
      for (const g of build.geometries) g.translate(-dx, 0, -dz);
      for (const body of build.bodies) shiftBody(body, dx, dz);
    }
    // Detached bodies aren't in world.bodies, so the caller didn't move them.
    for (const chunk of this.chunks.values()) {
      if (!chunk.physics) for (const body of chunk.bodies) shiftBody(body, dx, dz);
    }
  }

  /**
   * Ensures the region, queues in-range tiles whose terrain is ready,
   * builds until `deadline` (unbounded if awaitAll), and stages
   * out-of-range tiles for delayed unload.
   */
  async update(centerTx, centerTy, awaitAll = false, deadline = Infinity) {
    this._centerTx = centerTx;
    this._centerTy = centerTy;
    const ensure = this._ensureRegion(centerTx, centerTy);
    if (awaitAll) await ensure;
    else ensure.catch(() => {});

    const keepRadius = this._keepRadius();

    if (this._regionCovers(centerTx, centerTy)) {
      for (const { dx, dy } of BUILD_OFFSETS) {
        const tx = centerTx + dx;
        const ty = centerTy + dy;
        const key = this._key(tx, ty);
        const terrainReady = !this.terrain || this.terrain.isTileLoaded(tx, ty);
        if (terrainReady && !this.chunks.has(key) && !this._inProgressBuilds.has(key) && !this._queuedKeys.has(key)) {
          this._queuedKeys.add(key);
          this._buildQueue.push({ tx, ty, key });
        }
      }
    }

    if (awaitAll) deadline = Infinity;
    // Finish tiles paused mid-build before starting new ones.
    for (const [key, build] of this._inProgressBuilds) {
      if (performance.now() >= deadline) break;
      if (!inSquare(build.tx - centerTx, build.ty - centerTy, keepRadius)) {
        this._abandonChunkBuild(build);
        this._inProgressBuilds.delete(key);
        continue;
      }
      if (this._stepChunkBuild(build, deadline)) {
        this._finishChunkBuild(build);
        this._inProgressBuilds.delete(key);
      }
    }
    while (this._buildQueue.length && performance.now() < deadline) {
      const { tx, ty, key } = this._buildQueue.shift();
      this._queuedKeys.delete(key);
      if (this.chunks.has(key)) continue;
      if (!inSquare(tx - centerTx, ty - centerTy, keepRadius)) continue;
      const build = this._beginChunkBuild(tx, ty);
      if (this._stepChunkBuild(build, deadline)) {
        this._finishChunkBuild(build);
      } else {
        this._inProgressBuilds.set(key, build);
      }
    }

    for (const [k, chunk] of this.chunks) {
      this._syncChunkPhysics(chunk);
      const farAway = !inSquare(chunk.tx - centerTx, chunk.ty - centerTy, keepRadius);
      if (farAway) {
        if (!this.pendingRemoval.has(k)) this.pendingRemoval.set(k, UNLOAD_DELAY_TICKS);
      } else {
        this.pendingRemoval.delete(k);
      }
    }
    for (const [k, ticksLeft] of this.pendingRemoval) {
      if (ticksLeft <= 1) {
        this._unloadChunk(k);
      } else {
        this.pendingRemoval.set(k, ticksLeft - 1);
      }
    }
  }

  /** Far box layer (cosmetic), around the tile of the last update(); builds until `deadline`. */
  updateFar(deadline) {
    if (this._centerTx == null) return;
    this._far.update(this._centerTx, this._centerTy, this.chunks, deadline);
  }

  getStats() {
    let memoryBytes = 0;
    for (const chunk of this.chunks.values()) memoryBytes += chunk.bytes || 0;
    return {
      loaded: this.chunks.size,
      pendingRemoval: this.pendingRemoval.size,
      building: this._buildQueue.length + this._inProgressBuilds.size, // fetched, not yet built
      regionLoading: !!this._regionPending,
      regionFailed: !!this._regionFailedAt,
      usingCachedData: this._usingCachedData,
      lastError: this._lastError,
      created: this.stats.created,
      removed: this.stats.removed,
      buildings: this.stats.buildings,
      memoryBytes,
      far: this._far.getStats(),
    };
  }
}
