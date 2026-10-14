// 3D buildings from OpenFreeMap vector tiles (static CDN files; more
// reliable than the overloaded public Overpass servers). The `building`
// layer already carries render_height. Tiles come at BUILDING_TILE_ZOOM
// (14) and are bucketed by centroid into DETAIL_ZOOM (15) tiles, streamed
// on the terrain detail grid. Decoded tiles are written to IndexedDB
// (buildingsCache.js) as an offline fallback.
// Limitations: outer ring only, flat roofs.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { tileX2lon, tileY2lat, lon2tileX, lat2tileY, latLonToLocal } from './geo.js';
import { cacheTiles, readCachedRegion } from './buildingsCache.js';
import { fetchVectorTileLayer } from './tiles/openFreeMap.js';
import {
  DETAIL_ZOOM,
  DETAIL_RADIUS,
  UNLOAD_MARGIN,
  UNLOAD_DELAY_TICKS,
  circleOffsets,
  inCircle,
  GROUND_COLLISION_GROUP,
} from './terrain.js';

const BUILDING_TILE_ZOOM = 14; // the building layer's maxzoom

// Separate from GROUND_COLLISION_GROUP so ground raycasts ignore roofs.
export const BUILDING_COLLISION_GROUP = 4;
// Paired with CHASSIS_MATERIAL in physicsSetup.js (low friction, so the
// car slides along walls instead of snagging).
export const BUILDING_MATERIAL = new CANNON.Material('building');

const DEFAULT_HEIGHT_METERS = 6; // when render_height is missing
const MIN_HEIGHT_METERS = 2;
// Physics prism extends this far below the lowest ground sample, so slopes
// and tile seams never leave a gap to drive under.
const BUILDING_SKIRT_DEPTH_M = 4;

const MIN_FOOTPRINT_POINTS = 3;
const MAX_FOOTPRINT_METERS = 500; // larger = bad data at this scale

const BUILDING_COLOR = 0xb8b0a4;
const DEFAULT_BUILDING_COLOR = new THREE.Color(BUILDING_COLOR);

// The optional `colour` field is a hex string or CSS keyword; anything
// else counts as missing and gets the deterministic grey fallback.
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const _parsedColorCache = new Map(); // raw `colour` string -> plain 0xRRGGBB int (or null if unrecognized)
const _colorParseScratch = new THREE.Color();
const _vertexColorScratch = new THREE.Color();

// Untagged buildings get a stable grey derived from their OSM id, so a
// block isn't one flat colour but each building stays the same shade.
const FALLBACK_GREY_LIGHT = 0xd8; // single channel, 0-255 - grayscale, so R=G=B
const FALLBACK_GREY_DARK = 0x58;

// FNV-1a over the id string (OSM ids exceed 32 bits, so no bitwise ops on them).
function fnv1aHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic grey (0xRRGGBB) for a stable building key. */
function greyFromKey(key) {
  const t = fnv1aHash(String(key)) / 0xffffffff;
  const channel = Math.round(FALLBACK_GREY_DARK + t * (FALLBACK_GREY_LIGHT - FALLBACK_GREY_DARK));
  return channel * 0x010101;
}

// Returns a plain int (not THREE.Color) so it survives IndexedDB cloning.
function parseBuildingColor(props) {
  const raw = props && props.colour;
  if (typeof raw !== 'string' || !raw) return null;
  const trimmed = raw.trim();
  if (_parsedColorCache.has(trimmed)) return _parsedColorCache.get(trimmed);
  let hex = null;
  if (HEX_COLOR_RE.test(trimmed) || THREE.Color.NAMES[trimmed.toLowerCase()] !== undefined) {
    hex = _colorParseScratch.setStyle(trimmed).getHex();
  }
  _parsedColorCache.set(trimmed, hex);
  return hex;
}

// Building is time-sliced: at most this many ms per frame, resumed next
// frame, so entering new territory never stutters.
const BUILD_TIME_BUDGET_MS = 6;
const BUILD_TIME_CHECK_INTERVAL = 4; // buildings between clock checks

const REGION_MARGIN_TILES = 2; // extra tiles fetched beyond the keep radius
const REGION_RETRY_COOLDOWN_MS = 8000;
const TILE_ZOOM_RATIO = 2 ** (DETAIL_ZOOM - BUILDING_TILE_ZOOM);
const MAX_FEATURES_PER_TILE = 8000; // cap for dense city tiles


/** Fetches one z14 tile; returns detail-tile key -> [{ ring: [{lat, lon}], height, color }]. */
async function fetchBuildingTile(tx14, ty14) {
  const layer = await fetchVectorTileLayer(BUILDING_TILE_ZOOM, tx14, ty14, 'building');
  const byTile = new Map();
  if (!layer) return byTile;

  const featureCount = Math.min(layer.length, MAX_FEATURES_PER_TILE);
  for (let i = 0; i < featureCount; i++) {
    try {
      const feature = layer.feature(i);
      if (feature.properties.hide_3d) continue; // covered by a more detailed part

      const rings = feature.loadGeometry();
      if (!rings.length) continue;
      const outer = rings[0];
      if (outer.length < MIN_FOOTPRINT_POINTS) continue;

      const extent = layer.extent;
      const ring = outer.map((p) => ({
        lat: tileY2lat(ty14 + p.y / extent, BUILDING_TILE_ZOOM),
        lon: tileX2lon(tx14 + p.x / extent, BUILDING_TILE_ZOOM),
      }));

      const height = parseHeightMeters(feature.properties);
      const color = parseBuildingColor(feature.properties) ?? greyFromKey(feature.id != null ? feature.id : `${tx14}_${ty14}_${i}`);

      let sumLat = 0;
      let sumLon = 0;
      for (const p of ring) {
        sumLat += p.lat;
        sumLon += p.lon;
      }
      const centroidLat = sumLat / ring.length;
      const centroidLon = sumLon / ring.length;
      const detailTx = Math.floor(lon2tileX(centroidLon, DETAIL_ZOOM));
      const detailTy = Math.floor(lat2tileY(centroidLat, DETAIL_ZOOM));
      const key = `${detailTx}_${detailTy}`;

      let list = byTile.get(key);
      if (!list) {
        list = [];
        byTile.set(key, list);
      }
      list.push({ ring, height, color });
    } catch (err) {
      console.warn('Skipping one malformed building feature', tx14, ty14, err);
    }
  }
  return byTile;
}

function parseHeightMeters(props) {
  if (!props) return DEFAULT_HEIGHT_METERS;
  const meters = parseFloat(props.render_height);
  if (Number.isFinite(meters) && meters > 0) return Math.max(MIN_HEIGHT_METERS, meters);
  return DEFAULT_HEIGHT_METERS;
}

/** Rough memory estimate for the debug HUD. */
function estimateTileBytes(mergedGeometry, bodyCount) {
  const position = mergedGeometry?.attributes?.position;
  const vertexBytes = position ? position.array.length * 2 * 4 : 0; // position + normal, 4 bytes/float
  const bodyBytes = bodyCount * 200; // rough flat estimate per CANNON.Box body
  return vertexBytes + bodyBytes;
}

/**
 * Convex hull of {x, z} points (Andrew's monotone chain), CCW - the
 * physics shape must be convex; the render mesh uses the exact outline.
 */
function convexHull2D(points) {
  const pts = points
    .slice()
    .sort((a, b) => a.x - b.x || a.z - b.z)
    .filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x || p.z !== arr[i - 1].z); // drop repeats
  if (pts.length < 3) return pts;

  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
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
export class BuildingsManager {
  constructor(scene, world, originLat, originLon, terrain) {
    this.scene = scene;
    this.world = world;
    this.originLat = originLat;
    this.originLon = originLon;
    this.scaleLat = originLat; // see geo.js; kept by shiftOrigin()
    // Tiles wait for their terrain tile: ground height comes from raycasting its body.
    this.terrain = terrain;
    this.chunks = new Map(); // key -> { mesh, bodies[], hitboxMeshes[], tx, ty, bytes }
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
    this._hitboxMaterial = new THREE.MeshBasicMaterial({
      color: 0xff33ff,
      wireframe: true,
      depthWrite: false,
    });
    this._hitboxMaterialOccluded = new THREE.MeshBasicMaterial({
      color: 0x660066,
      wireframe: true,
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
  }

  _key(tx, ty) {
    return `${tx}_${ty}`;
  }

  _keepRadius() {
    return DETAIL_RADIUS + UNLOAD_MARGIN;
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


  /** Terrain height at (x, z) via a ground raycast; 0 if nothing hit. */
  _groundHeightAt(x, z) {
    const from = new CANNON.Vec3(x, 2000, z);
    const to = new CANNON.Vec3(x, -2000, z);
    const result = new CANNON.RaycastResult();
    this.world.raycastClosest(from, to, { collisionFilterMask: GROUND_COLLISION_GROUP }, result);
    return result.hasHit ? result.hitPointWorld.y : 0;
  }

  /** Lowest ground under the hull corners/centre - bottom of the physics prism only. */
  _minGroundHeightAt(hull, centerX, centerZ, centerGroundY) {
    let min = centerGroundY;
    for (const p of hull) {
      const y = this._groundHeightAt(p.x, p.z);
      if (y < min) min = y;
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
      hitboxMeshes: [],
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

        const groundY = this._groundHeightAt(built.aabb.centerX, built.aabb.centerZ);
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
        this.world.addBody(body);
        build.bodies.push(body);

        // Debug wireframe of the same hull prism (visible + occluded pair).
        const hullShape = new THREE.Shape();
        built.hull.forEach((p, i) => {
          const lx = p.x - center.x;
          const lz = p.z - center.z;
          if (i === 0) hullShape.moveTo(lx, -lz);
          else hullShape.lineTo(lx, -lz);
        });
        const hitboxGeometry = new THREE.ExtrudeGeometry(hullShape, {
          depth: physicsHalfHeight * 2,
          bevelEnabled: false,
          curveSegments: 1,
        });
        hitboxGeometry.rotateX(-Math.PI / 2);
        hitboxGeometry.translate(0, -physicsHalfHeight, 0);
        const hitboxMesh = new THREE.Mesh(hitboxGeometry, this._hitboxMaterial);
        hitboxMesh.position.copy(body.position);
        hitboxMesh.visible = this._hitboxesVisible;
        hitboxMesh.renderOrder = 999;
        this.scene.add(hitboxMesh);
        build.hitboxMeshes.push(hitboxMesh);

        const hitboxMeshOccluded = new THREE.Mesh(hitboxGeometry, this._hitboxMaterialOccluded);
        hitboxMeshOccluded.position.copy(body.position);
        hitboxMeshOccluded.visible = this._hitboxesVisible;
        hitboxMeshOccluded.renderOrder = 999;
        this.scene.add(hitboxMeshOccluded);
        build.hitboxMeshes.push(hitboxMeshOccluded);

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
    const { tx, ty, key, geometries, bodies, hitboxMeshes, skipped } = build;
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
    this.chunks.set(key, { mesh, bodies, hitboxMeshes, tx, ty, bytes });
    this.stats.created++;
    this.stats.buildings += bodies.length;
  }

  /** Removes the partial bodies/meshes of a build paused mid-tile. */
  _abandonChunkBuild(build) {
    for (const body of build.bodies) this.world.removeBody(body);
    for (const hitboxMesh of build.hitboxMeshes) {
      this.scene.remove(hitboxMesh);
      hitboxMesh.geometry.dispose();
    }
    for (const g of build.geometries) g.dispose();
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
    for (const body of chunk.bodies) this.world.removeBody(body);
    // Hitbox pairs share a geometry; double dispose is a no-op.
    for (const hitboxMesh of chunk.hitboxMeshes) {
      this.scene.remove(hitboxMesh);
      hitboxMesh.geometry.dispose();
    }
    this.stats.buildings -= chunk.bodies.length;
    this.chunks.delete(key);
    this.pendingRemoval.delete(key);
    this.stats.removed++;
  }

  /** M-key debug toggle for hitbox wireframes. */
  setHitboxesVisible(visible) {
    this._hitboxesVisible = visible;
    for (const chunk of this.chunks.values()) {
      for (const hitboxMesh of chunk.hitboxMeshes) hitboxMesh.visible = visible;
    }
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
  }

  /**
   * Floating-origin shift by (dx, dz): scene objects and bodies were already
   * translated by the caller; partial builds' geometry (not in the scene yet)
   * is moved here.
   */
  shiftOrigin(lat, lon, dx, dz) {
    this.originLat = lat;
    this.originLon = lon;
    for (const build of this._inProgressBuilds.values()) {
      for (const g of build.geometries) g.translate(-dx, 0, -dz);
    }
  }

  /**
   * Ensures the region, queues in-range tiles whose terrain is ready,
   * builds within the frame budget (unbounded if awaitAll), and stages
   * out-of-range tiles for delayed unload.
   */
  async update(centerTx, centerTy, awaitAll = false) {
    const ensure = this._ensureRegion(centerTx, centerTy);
    if (awaitAll) await ensure;
    else ensure.catch(() => {});

    const keepRadius = this._keepRadius();

    if (this._regionCovers(centerTx, centerTy)) {
      for (const { dx, dy } of circleOffsets(DETAIL_RADIUS)) {
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

    const deadline = awaitAll ? Infinity : performance.now() + BUILD_TIME_BUDGET_MS;
    // Finish tiles paused mid-build before starting new ones.
    for (const [key, build] of this._inProgressBuilds) {
      if (performance.now() >= deadline) break;
      if (!inCircle(build.tx - centerTx, build.ty - centerTy, keepRadius)) {
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
      if (!inCircle(tx - centerTx, ty - centerTy, keepRadius)) continue;
      const build = this._beginChunkBuild(tx, ty);
      if (this._stepChunkBuild(build, deadline)) {
        this._finishChunkBuild(build);
      } else {
        this._inProgressBuilds.set(key, build);
      }
    }

    for (const [k, chunk] of this.chunks) {
      const farAway = !inCircle(chunk.tx - centerTx, chunk.ty - centerTy, keepRadius);
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
    };
  }
}
