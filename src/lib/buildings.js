// 3D building footprints extruded from free OpenStreetMap data, served as
// pre-built vector tiles by OpenFreeMap (https://openfreemap.org) - a free,
// keyless, CDN-hosted static-file tile service (just nginx serving files,
// no live query engine to overload). Each tile is a Mapbox Vector Tile
// (MVT/.pbf) containing (among other layers) a `building` layer, where
// every building footprint polygon already has OpenMapTiles-computed
// `render_height`/`render_min_height` fields (meters) - i.e. the
// height-from-tags estimation this module used to do by hand against raw
// Overpass data has effectively already been done upstream.
//
// Why not the Overpass API (this module's original data source): Overpass
// instances are shared, best-effort, live query servers that are prone to
// overload/downtime under real-world load (the flagship overpass-api.de
// instance's own docs now explicitly warn "this server is overloaded...
// do not expect high reliability"). OpenFreeMap's tiles are just static
// files on a CDN, which is a fundamentally more robust delivery model for
// this use case - and unlike a single big region query, many small tile
// requests in parallel is exactly what a CDN is built for.
//
// Buildings still stream in/out (mesh + physics body add/remove) per tile
// on exactly the same Web Mercator tile grid as the terrain detail tier
// (see terrain.js: DETAIL_ZOOM/DETAIL_RADIUS/UNLOAD_MARGIN/
// UNLOAD_DELAY_TICKS/circleOffsets/inCircle, all reused here rather than
// duplicated) - that's DETAIL_ZOOM (15). OpenFreeMap's building layer tops
// out at BUILDING_TILE_ZOOM (14), one zoom level coarser, so each fetched
// vector tile is decoded once and its buildings bucketed into the (up to
// four) DETAIL_ZOOM tiles it covers - see _fetchBuildingTile.
//
// Local persistence: every successfully-decoded tile is also written to an
// IndexedDB cache (see buildingsCache.js) so buildings already seen once
// keep showing up even if a later fetch fails (offline, CDN hiccup, etc).
//
// Limitations (fine for a POC, worth knowing): OpenMapTiles' building
// layer already drops most holes/complex multipolygon detail during its
// own generalization, and only the outer ring of each footprint is used
// here; all roofs are rendered flat at the tile's render_height.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { tileX2lon, tileY2lat, lon2tileX, lat2tileY, latLonToLocal } from './geo.js';
import { cacheTiles, readCachedRegion } from './buildingsCache.js';
import {
  DETAIL_ZOOM,
  DETAIL_RADIUS,
  UNLOAD_MARGIN,
  UNLOAD_DELAY_TICKS,
  circleOffsets,
  inCircle,
  GROUND_COLLISION_GROUP,
} from './terrain.js';

// OpenFreeMap's TileJSON, which advertises the current tile URL template
// (the path contains a data-version stamp that can change over time, e.g.
// ".../planet/20260913_164504_pt/{z}/{x}/{y}.pbf" - so it's fetched once
// and cached in memory rather than hardcoded).
const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';

// The building layer's own maxzoom (see TILEJSON_URL's vector_layers) -
// OpenMapTiles doesn't ship building detail any finer than this; tiles are
// fetched at this zoom and their contents bucketed down into DETAIL_ZOOM
// (15) tiles for streaming, same as the old Overpass-region code did by
// centroid.
const BUILDING_TILE_ZOOM = 14;

// Dedicated collision group for building bodies, distinct from
// GROUND_COLLISION_GROUP, so the anti-tunneling ground raycast in main.js
// (which filters specifically on GROUND_COLLISION_GROUP) doesn't mistake a
// building roof/wall for "the ground" - the car should be able to crash
// into a building, not get treated as standing on it.
export const BUILDING_COLLISION_GROUP = 4;

// Shared CANNON.Material tagging every building body, paired in main.js
// with car.js's CHASSIS_MATERIAL via a dedicated low-friction/bouncy
// ContactMaterial - so grazing a wall at a shallow angle slides the car
// along it (and off) rather than snagging to a dead stop.
export const BUILDING_MATERIAL = new CANNON.Material('building');

const DEFAULT_HEIGHT_METERS = 6; // ~2 stories, used on the rare feature missing render_height entirely
const MIN_HEIGHT_METERS = 2;

// Skip pathological footprints (bad data, or a way that isn't actually a
// closed polygon) rather than let them produce a degenerate/huge mesh.
const MIN_FOOTPRINT_POINTS = 3;
const MAX_FOOTPRINT_METERS = 500; // building footprints bigger than this are almost certainly bad data for this scale

const BUILDING_COLOR = 0xb8b0a4;

// How many BUILDING_TILE_ZOOM tiles beyond the detail tier's keep radius
// to keep fetched/cached in memory at once - the bigger this buffer, the
// less often new tiles need fetching as the player drives around (at the
// cost of holding more buildings in memory).
const REGION_MARGIN_TILES = 2;

// After a tile fetch fails (network error, timeout, CDN hiccup), wait this
// long before automatically trying that same tile again, so a persistent
// outage doesn't turn into a tight retry loop.
const TILE_RETRY_COOLDOWN_MS = 8000;

// Vector tile response feature cap per tile: a dense city-center tile can
// contain thousands of building features. Processing (let alone
// extruding+merging) unbounded numbers of them per tile would stall the
// main thread, so anything past this count in a single tile is simply not
// rendered.
const MAX_FEATURES_PER_TILE = 8000;


/**
 * Fetches (once, memoized) OpenFreeMap's TileJSON to learn the current
 * tile URL template - see TILEJSON_URL's comment above for why this isn't
 * just hardcoded.
 */
let tileUrlTemplatePromise = null;
async function getTileUrlTemplate() {
  if (!tileUrlTemplatePromise) {
    tileUrlTemplatePromise = fetch(TILEJSON_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`TileJSON request failed (${res.status})`);
        return res.json();
      })
      .then((json) => {
        const template = json?.tiles?.[0];
        if (!template) throw new Error('TileJSON response had no tiles[] entry');
        return template;
      })
      .catch((err) => {
        tileUrlTemplatePromise = null; // let the next attempt retry the TileJSON fetch itself
        throw err;
      });
  }
  return tileUrlTemplatePromise;
}

const FETCH_TIMEOUT_MS = 15000; // small single-tile requests, much quicker than the old big region queries

/**
 * Fetches and decodes one BUILDING_TILE_ZOOM vector tile, returning its
 * building features bucketed by which DETAIL_ZOOM tile their centroid
 * falls in - same shape _fetchRegion used to produce from an Overpass
 * response, so the rest of the class (chunk streaming, IndexedDB
 * write-through) doesn't need to know which data source it came from.
 */
async function fetchBuildingTile(tx14, ty14) {
  const template = await getTileUrlTemplate();
  const url = template.replace('{z}', BUILDING_TILE_ZOOM).replace('{x}', tx14).replace('{y}', ty14);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let buffer;
  try {
    const res = await fetch(url, { signal: controller.signal });
    // A 404 here just means "no data for this tile" (e.g. open water/no
    // buildings) for most tile servers, not an error - treat it as empty
    // rather than a failure worth retrying/falling back to cache for.
    if (res.status === 404) return new Map();
    if (!res.ok) throw new Error(`Tile request failed (${res.status})`);
    buffer = await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }

  const tile = new VectorTile(new PbfReader(new Uint8Array(buffer)));
  const layer = tile.layers.building;
  const byTile = new Map();
  if (!layer) return byTile;

  const featureCount = Math.min(layer.length, MAX_FEATURES_PER_TILE);
  for (let i = 0; i < featureCount; i++) {
    try {
      const feature = layer.feature(i);
      // hide_3d marks footprints OpenMapTiles' own styles intentionally
      // don't extrude (e.g. building parts covered by a more detailed
      // sibling feature) - respect that rather than double-drawing them.
      if (feature.properties.hide_3d) continue;

      const rings = feature.loadGeometry();
      if (!rings.length) continue;
      const outer = rings[0]; // only outer ring - see module doc comment on limitations
      if (outer.length < MIN_FOOTPRINT_POINTS) continue;

      const extent = layer.extent;
      const ring = outer.map((p) => ({
        lat: tileY2lat(ty14 + p.y / extent, BUILDING_TILE_ZOOM),
        lon: tileX2lon(tx14 + p.x / extent, BUILDING_TILE_ZOOM),
      }));

      const height = parseHeightMeters(feature.properties);

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
      list.push({ ring, height });
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

/**
 * Rough byte estimate of a tile's building meshes+physics data, matching
 * the spirit of terrain.js's estimateChunkBytes - good enough for the
 * "is this leaking?" memory readout, not exact.
 */
function estimateTileBytes(mergedGeometry, bodyCount) {
  const position = mergedGeometry?.attributes?.position;
  const vertexBytes = position ? position.array.length * 2 * 4 : 0; // position + normal, 4 bytes/float
  const bodyBytes = bodyCount * 200; // rough flat estimate per CANNON.Box body
  return vertexBytes + bodyBytes;
}

/**
 * Builds one extruded, flat-roofed mesh geometry for a building footprint
 * given as an array of {x, z} local-meter points (already deduplicated,
 * open ring), plus a matching CANNON.Box approximating its footprint AABB
 * for physics. Returns null if the footprint is degenerate.
 *
 * Extrusion technique: THREE.ExtrudeGeometry extrudes a 2D shape (in its
 * own X/Y plane) along +Z by `depth`. We feed it (x, -z) as the shape's
 * (x, y) so that after rotating the result -90deg around X (which maps
 * shape-Y -> world-Y "up" and extrusion-Z -> world-Z), the footprint's
 * original x/z land back in the right place: rotateX(-90deg) sends
 * (x, y, z) -> (x, z, -y), so world y = shape's extrusion depth (0..height,
 * correctly "up") and world z = -shape.y = -(-localZ) = localZ.
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

  return {
    geometry,
    aabb: {
      centerX: (minX + maxX) / 2,
      centerZ: (minZ + maxZ) / 2,
      halfX: Math.max(0.5, spanX / 2),
      halfZ: Math.max(0.5, spanZ / 2),
    },
  };
}

/**
 * Streams OSM building footprints, extruded to (estimated) real-world
 * height, as chunks aligned 1:1 with the terrain detail tier's tile grid,
 * fetched via single wide-area Overpass region queries (see module doc
 * comment above) rather than one request per tile.
 */
export class BuildingsManager {
  constructor(scene, world, originLat, originLon) {
    this.scene = scene;
    this.world = world;
    this.originLat = originLat;
    this.originLon = originLon;
    this.chunks = new Map(); // key -> { mesh, bodies[], hitboxMeshes[], tx, ty, bytes }
    this.pendingRemoval = new Map();
    this.stats = { created: 0, removed: 0, buildings: 0 };
    this.material = new THREE.MeshStandardMaterial({
      color: BUILDING_COLOR,
      roughness: 0.9,
      // OSM way winding order isn't guaranteed, and ExtrudeGeometry's
      // normals depend on it - render both faces so a reversed-winding
      // building's walls/roof don't vanish via backface culling.
      side: THREE.DoubleSide,
    });
    // Debug-only wireframe boxes marking each building body's actual
    // physics hitbox (its CANNON.Box shape) - created alongside every body
    // so toggling never has to walk/rebuild chunks, just flip .visible.
    // See setHitboxesVisible().
    this._hitboxMaterial = new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true, depthTest: false });
    this._hitboxesVisible = false;

    // Region cache: the last fetched tile-range and the buildings within it
    // (raw lat/lon rings + tags, bucketed by which tile their centroid
    // falls in) - see _ensureRegion/_fetchRegion.
    this._region = null; // { minTx, maxTx, minTy, maxTy }
    this._buildingsByTile = new Map(); // tileKey -> [{ ring: [{lat,lon}], height }]
    this._regionPending = null;
    this._regionFailedAt = 0;
    this._lastError = null;
    // True when the buildings currently loaded/covering _region came from
    // the local IndexedDB cache (see buildingsCache.js) rather than a live
    // Overpass fetch - i.e. the network is (or was) down and this is
    // best-effort stale data. Surfaced via getStats() for the HUD.
    this._usingCachedData = false;
    // Bumped on recenter() so a region fetch in flight from before a
    // respawn can detect it's stale and discard its result instead of
    // polluting the new location's cache.
    this._generation = 0;
  }

  _key(tx, ty) {
    return `${tx}_${ty}`;
  }

  _keepRadius() {
    return DETAIL_RADIUS + UNLOAD_MARGIN;
  }

  /** True if the current cached region fully covers keepRadius tiles around (centerTx, centerTy). */
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
   * Ensures a region covering keepRadius tiles around (centerTx, centerTy)
   * has been fetched, fetching a fresh (wider, buffered) one if not. Safe
   * to call every frame: a no-op once covered by a *live* fetch, coalesces
   * concurrent calls onto a single in-flight fetch, and backs off for a
   * cooldown period after a failure instead of retrying every single
   * frame. When the current coverage is only cache-fallback data (see
   * _fallBackToCache), a live retry is still attempted every cooldown
   * period so the app transparently upgrades back to fresh data once the
   * network recovers, instead of being stuck on stale data forever.
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
    const south = tileY2lat(region.maxTy + 1, DETAIL_ZOOM);
    const north = tileY2lat(region.minTy, DETAIL_ZOOM);
    const west = tileX2lon(region.minTx, DETAIL_ZOOM);
    const east = tileX2lon(region.maxTx + 1, DETAIL_ZOOM);

    const json = await queuedFetch(overpassQuery(south, west, north, east));
    if (generation !== this._generation) return; // stale - a recenter() happened while this was in flight

    const elements = json?.elements || [];
    const byTile = new Map();
    let total = 0;
    let skipped = 0;
    for (const el of elements.slice(0, MAX_ELEMENTS_PROCESSED)) {
      try {
        if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
        const raw = el.geometry;
        if (raw.some((p) => !p || typeof p.lat !== 'number' || typeof p.lon !== 'number')) {
          skipped++;
          continue;
        }
        if (raw.length < MIN_FOOTPRINT_POINTS + 1) continue; // closed ring needs >= 4 raw points

        // Closed ways repeat their first node as the last point; drop the
        // duplicate so buildFootprintGeometry gets an open ring.
        const closed =
          raw.length > 1 &&
          Math.abs(raw[0].lat - raw[raw.length - 1].lat) < 1e-9 &&
          Math.abs(raw[0].lon - raw[raw.length - 1].lon) < 1e-9;
        const ring = closed ? raw.slice(0, -1) : raw;
        if (ring.length < MIN_FOOTPRINT_POINTS) continue;

        let sumLat = 0;
        let sumLon = 0;
        for (const p of ring) {
          sumLat += p.lat;
          sumLon += p.lon;
        }
        const centroidLat = sumLat / ring.length;
        const centroidLon = sumLon / ring.length;
        const tx = Math.floor(lon2tileX(centroidLon, DETAIL_ZOOM));
        const ty = Math.floor(lat2tileY(centroidLat, DETAIL_ZOOM));
        const key = this._key(tx, ty);

        let list = byTile.get(key);
        if (!list) {
          list = [];
          byTile.set(key, list);
        }
        list.push({ ring, height: parseHeightMeters(el.tags) });
        total++;
      } catch (err) {
        skipped++;
        console.warn('Skipping one malformed building element', err);
      }
    }

    this._region = region;
    this._buildingsByTile = byTile;
    console.info(
      `Buildings region tx[${region.minTx}..${region.maxTx}] ty[${region.minTy}..${region.maxTy}]: ` +
        `${total} buildings bucketed into ${byTile.size} tiles${skipped ? `, ${skipped} skipped` : ''} ` +
        `(${elements.length} raw elements)`
    );

    // Write-through to the local IndexedDB cache so this data is still
    // available next time (this session or a future one) even if Overpass
    // is unreachable then - see buildingsCache.js. Fire-and-forget: a
    // cache-write failure must never block/break live rendering.
    cacheTiles(DETAIL_ZOOM, byTile).catch(() => {});

    // A freshly-fetched region invalidates any already-built tile that
    // isn't backed by (fresh) cache data anymore - but tiles currently in
    // view are about to be rebuilt from the new cache by the caller's
    // per-tile loop regardless, so nothing else to do here.
  }

  /**
   * Called when a live region fetch fails outright (all mirrors
   * unreachable). Looks up the same region's tiles in the local
   * IndexedDB cache (previously-seen buildings from earlier successful
   * fetches) and, if any are found, uses them as a best-effort stand-in so
   * previously-seen buildings keep rendering instead of the area going
   * empty. Marks `_usingCachedData` so the HUD can indicate the data may
   * be stale. A generation check guards against a recenter() happening
   * while this (also async) cache read is in flight.
   */
  async _fallBackToCache(region, generation) {
    const cached = await readCachedRegion(DETAIL_ZOOM, region.minTx, region.maxTx, region.minTy, region.maxTy);
    if (generation !== this._generation) return; // stale - a recenter() happened meanwhile
    if (cached.size === 0) return; // nothing cached for this area - leave region uncovered, will retry the network

    this._region = region;
    this._buildingsByTile = cached;
    this._usingCachedData = true;
    console.info(
      `Buildings: network fetch failed, using ${cached.size} cached tile(s) for region ` +
        `tx[${region.minTx}..${region.maxTx}] ty[${region.minTy}..${region.maxTy}]`
    );
  }


  /**
   * Samples ground height at a local (x, z) point by raycasting straight
   * down through the terrain's physics bodies (already loaded by the time
   * buildings stream in, since both tiers are driven from the same tile
   * grid/update cadence). Falls back to y=0 if nothing is hit yet - rare
   * and self-correcting since a flat-footed building is far less jarring
   * than a crash.
   */
  _groundHeightAt(x, z) {
    const from = new CANNON.Vec3(x, 2000, z);
    const to = new CANNON.Vec3(x, -2000, z);
    const result = new CANNON.RaycastResult();
    this.world.raycastClosest(from, to, { collisionFilterMask: GROUND_COLLISION_GROUP }, result);
    return result.hasHit ? result.hitPointWorld.y : 0;
  }

  /**
   * Builds one tile's chunk (mesh + physics bodies) synchronously from the
   * already-fetched region cache - no network I/O here, so it's cheap
   * enough to call every frame for every tile currently in view (it early-
   * returns if the tile's already loaded).
   */
  _loadChunkFromCache(tx, ty) {
    const key = this._key(tx, ty);
    if (this.chunks.has(key)) return;

    const list = this._buildingsByTile.get(key) || [];
    const geometries = [];
    const bodies = [];
    const hitboxMeshes = [];
    let skipped = 0;
    for (const entry of list) {
      try {
        const points = entry.ring.map((p) => latLonToLocal(p.lat, p.lon, this.originLat, this.originLon));
        const built = buildFootprintGeometry(points, entry.height);
        if (!built) continue;

        const groundY = this._groundHeightAt(built.aabb.centerX, built.aabb.centerZ);
        const halfHeight = entry.height / 2;
        const body = new CANNON.Body({ mass: 0 });
        body.collisionFilterGroup = BUILDING_COLLISION_GROUP;
        body.addShape(new CANNON.Box(new CANNON.Vec3(built.aabb.halfX, halfHeight, built.aabb.halfZ)));
        body.position.set(built.aabb.centerX, groundY + halfHeight, built.aabb.centerZ);
        this.world.addBody(body);
        bodies.push(body);

        const hitboxMesh = new THREE.Mesh(
          new THREE.BoxGeometry(built.aabb.halfX * 2, halfHeight * 2, built.aabb.halfZ * 2),
          this._hitboxMaterial
        );
        hitboxMesh.position.copy(body.position);
        hitboxMesh.visible = this._hitboxesVisible;
        hitboxMesh.renderOrder = 999;
        this.scene.add(hitboxMesh);
        hitboxMeshes.push(hitboxMesh);

        // The extrusion geometry itself runs from y=0 to y=height in local
        // space; translate it up to the sampled ground height so the
        // merged-geometry vertices land at the right world Y.
        built.geometry.translate(0, groundY, 0);
        geometries.push(built.geometry);
      } catch (err) {
        skipped++;
        console.warn('Skipping one malformed building footprint', tx, ty, err);
      }
    }

    let mesh = null;
    if (geometries.length) {
      const merged = mergeGeometries(geometries, false);
      mesh = new THREE.Mesh(merged, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      for (const g of geometries) g.dispose();
    }
    if (skipped) console.warn(`Buildings tile ${tx},${ty}: ${skipped} malformed footprints skipped`);

    const bytes = estimateTileBytes(mesh?.geometry, bodies.length);
    this.chunks.set(key, { mesh, bodies, hitboxMeshes, tx, ty, bytes });
    this.stats.created++;
    this.stats.buildings += bodies.length;
  }

  _unloadChunk(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    if (chunk.mesh) {
      this.scene.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
    }
    for (const body of chunk.bodies) this.world.removeBody(body);
    for (const hitboxMesh of chunk.hitboxMeshes) {
      this.scene.remove(hitboxMesh);
      hitboxMesh.geometry.dispose();
    }
    this.stats.buildings -= chunk.bodies.length;
    this.chunks.delete(key);
    this.pendingRemoval.delete(key);
    this.stats.removed++;
  }

  /** Toggles visibility of every building's debug collision-hitbox wireframe (see main.js's M-key debug toggle). */
  setHitboxesVisible(visible) {
    this._hitboxesVisible = visible;
    for (const chunk of this.chunks.values()) {
      for (const hitboxMesh of chunk.hitboxMeshes) hitboxMesh.visible = visible;
    }
  }

  /**
   * Re-centers on a new lat/lon origin (matching TerrainManager.recenter):
   * tears down every currently-loaded building tile and drops the region
   * cache so nothing from the old location lingers, before the caller
   * streams in a fresh batch around the new origin's local (0, 0).
   */
  recenter(lat, lon) {
    for (const key of Array.from(this.chunks.keys())) this._unloadChunk(key);
    this.pendingRemoval.clear();
    this._region = null;
    this._buildingsByTile = new Map();
    this._regionPending = null;
    this._regionFailedAt = 0;
    this._lastError = null;
    this._usingCachedData = false;
    this._generation++;
    this.originLat = lat;
    this.originLon = lon;
  }

  /**
   * Ensures the region covering (centerTx, centerTy) is fetched, then
   * (re)builds every tile within the detail tier's circular radius from
   * that cache, and stages/unloads tiles that have drifted out of range -
   * mirroring TerrainManager.update()'s detail-tier bookkeeping (same tile
   * grid, circular radius, and unload-delay constants).
   */
  async update(centerTx, centerTy, awaitAll = false) {
    const ensure = this._ensureRegion(centerTx, centerTy);
    if (awaitAll) await ensure;
    else ensure.catch(() => {});

    if (this._regionCovers(centerTx, centerTy)) {
      for (const { dx, dy } of circleOffsets(DETAIL_RADIUS)) {
        this._loadChunkFromCache(centerTx + dx, centerTy + dy);
      }
    }

    const keepRadius = this._keepRadius();
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
