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
// Extra depth the physics prism extends below the lowest ground sample
// under its footprint (see _minGroundHeightAt) - a buffer against slopes/
// tile seams/raycast misses so the solid hitbox always reaches real
// terrain, with no gap a car could drive or get stuck underneath.
const BUILDING_SKIRT_DEPTH_M = 4;

// Skip pathological footprints (bad data, or a way that isn't actually a
// closed polygon) rather than let them produce a degenerate/huge mesh.
const MIN_FOOTPRINT_POINTS = 3;
const MAX_FOOTPRINT_METERS = 500; // building footprints bigger than this are almost certainly bad data for this scale

const BUILDING_COLOR = 0xb8b0a4;

// Per-frame time budget (ms) spent synchronously extruding/physics-building
// already-fetched buildings into meshes/bodies. A freshly-available region
// can have dozens of tiles' worth of buildings (each needing a convex
// hull, several ground raycasts, and an ExtrudeGeometry) become buildable
// in the very same frame its network fetch resolves - doing all of that
// synchronously in one go is what used to cause a visible freeze/stutter
// whenever the player crossed into unexplored territory. Capping how much
// of that CPU work happens per frame (continuing across frames via
// `_buildQueue`/`_inProgressBuilds` below, see _stepChunkBuild) spreads it
// out instead, trading "tiles pop in instantly" for "tiles pop in across a
// handful of frames, never a stutter" - same end result a few frames
// later, no dropped frame in between.
const BUILD_TIME_BUDGET_MS = 6;

// How many buildings to process before re-checking the clock within a
// single _stepChunkBuild call - checking performance.now() after every
// single building would add measurable overhead of its own for dense
// tiles, so time is only sampled every this-many buildings.
const BUILD_TIME_CHECK_INTERVAL = 4;

// How many BUILDING_TILE_ZOOM tiles beyond the detail tier's keep radius
// to keep fetched/cached in memory at once - the bigger this buffer, the
// less often new tiles need fetching as the player drives around (at the
// cost of holding more buildings in memory).
const REGION_MARGIN_TILES = 2;

// After a region fetch fails outright (network error, timeout, CDN hiccup
// affecting every tile in it), wait this long before automatically
// retrying, so a persistent outage doesn't turn into a tight retry loop.
const REGION_RETRY_COOLDOWN_MS = 8000;

// Ratio between DETAIL_ZOOM (the tile grid buildings are streamed/cached
// on, matching terrain.js) and BUILDING_TILE_ZOOM (the coarser zoom
// OpenFreeMap's building layer is actually served at) - i.e. how many
// DETAIL_ZOOM tiles per side one fetched vector tile covers.
const TILE_ZOOM_RATIO = 2 ** (DETAIL_ZOOM - BUILDING_TILE_ZOOM);

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
// Exported so streets.js (same OpenFreeMap tiles, different layer) can
// reuse this instead of independently re-fetching/memoizing the TileJSON.
export async function getTileUrlTemplate() {
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
 * Computes the convex hull of a set of 2D {x, z} points via Andrew's
 * monotone chain, returning hull vertices in counter-clockwise order (in
 * the x-z plane, matching the winding CANNON.ConvexPolyhedron expects for
 * outward-facing normals - see buildFootprintPrism below). Used because
 * most OSM building footprints are already convex (simple rectangles/
 * L-shapes' bounding hull is close enough), and a real physics hitbox
 * needs a convex shape - unlike the render mesh, which can use the exact
 * (possibly concave) footprint outline since it's not used for collision.
 */
function convexHull2D(points) {
  const pts = points
    .slice()
    .sort((a, b) => a.x - b.x || a.z - b.z)
    // Drop consecutive duplicates (degenerate footprints occasionally
    // repeat a point), which would otherwise produce zero-length hull
    // edges/cross products.
    .filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x || p.z !== arr[i - 1].z);
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

/**
 * Builds a CANNON.ConvexPolyhedron prism (vertical walls + flat top/
 * bottom) from a convex hull footprint, centered on `center` and spanning
 * `-halfHeight..+halfHeight` in Y - i.e. a physics shape tracing the
 * building's real (convex) footprint instead of its bounding-box AABB, so
 * rotated/non-rectangular buildings' hitboxes actually line up with what's
 * rendered. Vertex/face layout mirrors cannon-es's own built-in Cylinder
 * shape (interleaved bottom/top rings, side quads, top ring reversed) -
 * a pattern already verified to produce correctly-wound (outward-normal)
 * faces.
 */
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
 * Builds one extruded, flat-roofed mesh geometry for a building footprint
 * given as an array of {x, z} local-meter points (already deduplicated,
 * open ring), plus a matching convex-hull footprint (for a physics shape
 * that actually matches the building, see buildFootprintPrism) and its
 * AABB (used only to sample ground height / as a byte-size estimate).
 * Returns null if the footprint is degenerate.
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

/**
 * Streams OSM building footprints, extruded to (estimated) real-world
 * height, as chunks aligned 1:1 with the terrain detail tier's tile grid,
 * fetched as OpenFreeMap vector tiles (see module doc comment above and
 * fetchBuildingTile) covering a buffered region around the player.
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
    // Time-sliced build pipeline (see BUILD_TIME_BUDGET_MS above): tiles
    // whose buildings are ready to be extruded/physics-built but haven't
    // started yet sit in `_buildQueue`; a tile that's partway through
    // (paused mid-tile once the frame's time budget ran out) lives in
    // `_inProgressBuilds` instead, keyed the same way as `chunks`, so it
    // can be resumed exactly where it left off next frame.
    this._buildQueue = []; // [{ tx, ty, key }]
    this._queuedKeys = new Set();
    this._inProgressBuilds = new Map(); // key -> build descriptor (see _beginChunkBuild)
    this.material = new THREE.MeshStandardMaterial({
      color: BUILDING_COLOR,
      roughness: 0.9,
      // OSM way winding order isn't guaranteed, and ExtrudeGeometry's
      // normals depend on it - render both faces so a reversed-winding
      // building's walls/roof don't vanish via backface culling.
      side: THREE.DoubleSide,
    });
    // Debug-only wireframe boxes marking each building body's actual
    // physics hitbox (its convex-hull prism shape) - created alongside every body
    // so toggling never has to walk/rebuild chunks, just flip .visible.
    // See setHitboxesVisible().
    //
    // Rendered as two overlapping wireframes sharing the same geometry
    // rather than one depthTest:false mesh, so a line's brightness reflects
    // whether it's actually visible or hidden behind something else (e.g.
    // another building, or the hitbox's own far walls) instead of every
    // line always drawing on top at full brightness regardless of what's
    // in front of it:
    //  - `_hitboxMaterial`: normal depth test (depthFunc defaults to
    //    LessEqual), so this one only draws where the line is genuinely
    //    the frontmost thing - bright pink, the "actually visible" case.
    //  - `_hitboxMaterialOccluded`: the opposite comparison (GreaterDepth),
    //    so it only draws where something else already won the depth
    //    test - dark pink, the "covered by something else" case. Neither
    //    writes depth (depthWrite: false) so this x-ray pair never
    //    interferes with each other's test or anything drawn after them.
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
    // Convert the DETAIL_ZOOM tile range into the (coarser) BUILDING_TILE_ZOOM
    // tiles that cover it, and fetch each one from OpenFreeMap - see
    // fetchBuildingTile and the module doc comment above.
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
    if (generation !== this._generation) return; // stale - a recenter() happened while this was in flight

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

    // Only treat this as a hard failure (triggering the cache fallback) if
    // every single tile request failed - a handful of CDN hiccups amid an
    // otherwise-successful region shouldn't blank out the whole area.
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

    // Write-through to the local IndexedDB cache so this data is still
    // available next time (this session or a future one) even if the CDN
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
   * Samples ground height at the footprint's center plus every hull
   * corner and returns the lowest one. A building's physics prism used to
   * sit flat at just the center sample's height - fine on level ground,
   * but on any slope (or right at a terrain tile seam) some corners of
   * the footprint end up with real terrain below the prism's bottom face,
   * leaving a gap a car can drive/get stuck under. Used only for the
   * physics shape's bottom (see _stepChunkBuild) - the visible mesh
   * still sits at the single center-sampled height, which is the correct
   * "flat foundation" look for a real building anyway.
   */
  _minGroundHeightAt(hull, centerX, centerZ, centerGroundY) {
    let min = centerGroundY;
    for (const p of hull) {
      const y = this._groundHeightAt(p.x, p.z);
      if (y < min) min = y;
    }
    return min;
  }

  /**
   * Starts a new time-sliced build for one tile from the already-fetched
   * region cache (no network I/O) - returns a resumable "build descriptor"
   * consumed by _stepChunkBuild/_finishChunkBuild rather than doing all the
   * work here, so a dense tile's worth of buildings never has to finish in
   * a single frame (see BUILD_TIME_BUDGET_MS above).
   */
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

  /**
   * Processes buildings from a build descriptor (see _beginChunkBuild)
   * starting at `build.index`, stopping either when the tile's whole list
   * is done or when `deadline` (a performance.now() timestamp) is reached -
   * whichever comes first. Safe to call again on the same descriptor next
   * frame to resume exactly where it left off. Returns true once the tile
   * is fully processed (ready for _finishChunkBuild), false if paused.
   */
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
        const points = entry.ring.map((p) => latLonToLocal(p.lat, p.lon, this.originLat, this.originLon));
        const built = buildFootprintGeometry(points, entry.height);
        if (!built) continue;

        const groundY = this._groundHeightAt(built.aabb.centerX, built.aabb.centerZ);
        const center = { x: built.aabb.centerX, z: built.aabb.centerZ };
        // Physics prism's bottom sits below the lowest ground sample
        // under the footprint (not just its center), plus a skirt buffer -
        // see _minGroundHeightAt/BUILDING_SKIRT_DEPTH_M - so sloped ground
        // or a terrain tile seam under part of the building never leaves a
        // gap to drive/get stuck under. Its roof stays at the same height
        // above the center-sampled ground as before (unrelated to this
        // fix), so the visible mesh (which uses `groundY` below,
        // unchanged) still lines up with the physics shape's top.
        const topY = groundY + entry.height;
        const bottomY = this._minGroundHeightAt(built.hull, center.x, center.z, groundY) - BUILDING_SKIRT_DEPTH_M;
        const physicsHalfHeight = (topY - bottomY) / 2;
        const physicsCenterY = (topY + bottomY) / 2;
        // Physics: a convex-hull prism tracing the building's actual
        // (rotated/non-rectangular) footprint, previously an axis-aligned
        // CANNON.Box approximating just its AABB - which visibly didn't
        // match rotated buildings' rendered walls. Tagged with
        // BUILDING_MATERIAL so the dedicated low-friction/bouncy
        // chassis<->building ContactMaterial (see physicsSetup.js) actually
        // applies - it previously never did, since these bodies were never
        // given a `material` at all and silently fell back to the world
        // default contact tuning.
        const body = new CANNON.Body({ mass: 0, material: BUILDING_MATERIAL });
        body.collisionFilterGroup = BUILDING_COLLISION_GROUP;
        body.addShape(buildFootprintPrism(built.hull, center, physicsHalfHeight));
        body.position.set(center.x, physicsCenterY, center.z);
        this.world.addBody(body);
        build.bodies.push(body);

        // Debug hitbox wireframe: the same convex-hull prism as the
        // physics shape above (built via the same extrusion technique as
        // the visible mesh, just from the hull instead of the full
        // footprint outline), so toggling it (M key) shows exactly what
        // the car actually collides with.
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
        // Two meshes sharing this one geometry - see the materials' doc
        // comment above for why - rather than a single mesh, so occluded
        // lines render dark instead of every line always drawing on top.
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

        // The extrusion geometry itself runs from y=0 to y=height in local
        // space; translate it up to the sampled ground height so the
        // merged-geometry vertices land at the right world Y.
        built.geometry.translate(0, groundY, 0);
        build.geometries.push(built.geometry);
      } catch (err) {
        build.skipped++;
        console.warn('Skipping one malformed building footprint', build.tx, build.ty, err);
      }
    }
    return true;
  }

  /** Finalizes a fully-processed build descriptor (see _stepChunkBuild) into a chunk in `this.chunks`. */
  _finishChunkBuild(build) {
    const { tx, ty, key, geometries, bodies, hitboxMeshes, skipped } = build;
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

  /**
   * Discards a build descriptor that's paused mid-tile (see _stepChunkBuild)
   * without finishing it - used when a tile drifts out of range or the
   * manager recenters while a build is in flight, so its partially-created
   * bodies/hitbox meshes don't leak into the world/scene unfinished.
   */
  _abandonChunkBuild(build) {
    for (const body of build.bodies) this.world.removeBody(body);
    for (const hitboxMesh of build.hitboxMeshes) {
      this.scene.remove(hitboxMesh);
      hitboxMesh.geometry.dispose();
    }
    for (const g of build.geometries) g.dispose();
  }

  /** True once a tile's mesh/physics have actually been built (not just fetched) - used by the debug stats HUD's per-tile progress indicator. */
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
    // Each building contributes two meshes sharing one geometry (see the
    // bright/occluded pair in _stepChunkBuild) - disposing it via both
    // is harmless (BufferGeometry.dispose() is a no-op past the first
    // call), just simpler than tracking which half of the pair owns it.
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
    // Abandon (not finish) any tile build that was mid-flight - it almost
    // certainly belongs to the old location's tile grid, and finishing it
    // would just add soon-to-be-unloaded bodies/meshes for nothing.
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
  }

  /**
   * Ensures the region covering (centerTx, centerTy) is fetched, then
   * (re)builds every tile within the detail tier's circular radius from
   * that cache, and stages/unloads tiles that have drifted out of range -
   * mirroring TerrainManager.update()'s detail-tier bookkeeping (same tile
   * grid, circular radius, and unload-delay constants). The actual
   * mesh/physics building is time-sliced (see BUILD_TIME_BUDGET_MS,
   * _stepChunkBuild) rather than all done in one go, so a newly-available
   * region's worth of tiles never freezes the frame they become ready in -
   * unless `awaitAll` (teleport/initial load, already behind its own
   * blocking loading-screen await), which runs the build queue to
   * completion with no per-frame time limit instead.
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
        if (!this.chunks.has(key) && !this._inProgressBuilds.has(key) && !this._queuedKeys.has(key)) {
          this._queuedKeys.add(key);
          this._buildQueue.push({ tx, ty, key });
        }
      }
    }

    const deadline = awaitAll ? Infinity : performance.now() + BUILD_TIME_BUDGET_MS;
    // Resume anything paused mid-tile last frame first, so a tile already
    // partway built finishes before a brand new one is even started.
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
      if (this.chunks.has(key)) continue; // already built via some other path
      if (!inCircle(tx - centerTx, ty - centerTy, keepRadius)) continue; // drifted out of range while queued
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
      // Tiles whose buildings are fetched but not yet (fully) built into
      // meshes/bodies (see BUILD_TIME_BUDGET_MS) - surfaced so the HUD can
      // show "still constructing" separately from "still downloading".
      building: this._buildQueue.length + this._inProgressBuilds.size,
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
