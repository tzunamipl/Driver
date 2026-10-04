// Shared streaming/rendering engine behind waterAreas.js (and a template
// for any future filled-polygon debug overlay, e.g. landcover/parks):
// decodes polygon-geometry features (OSM water bodies, currently) from
// OpenFreeMap's vector tiles (see buildings.js's doc comment for why
// OpenFreeMap over a live Overpass query) and renders them as flat,
// ground-hugging colored meshes, streamed on the same DETAIL_ZOOM tile
// grid as terrain.js/buildings.js/vectorLineLayer.js.
//
// Bucketed per *polygon* (by its outer ring's vertex-average centroid),
// mirroring buildings.js's footprint bucketing - not per-segment like
// vectorLineLayer.js, since a filled area doesn't have a meaningful
// "midpoint streams in tile-by-tile" subdivision the way a long line does.
// Known limitation (same tradeoff buildings.js explicitly accepts for its
// own footprints): a polygon bigger than one DETAIL_ZOOM tile (plausible
// for a large lake/sea - DETAIL_ZOOM tiles are only ~300-400m, see
// terrain.js) renders entirely in whichever single tile its centroid
// landed in, so it can pop in/out as a whole rather than clipping at tile
// boundaries. Fine for a cosmetic debug overlay, not worth the
// complexity of real per-tile polygon clipping here.
//
// The fill *meshes* are a cosmetic debug overlay only (see debugVisuals.js's
// M-key toggle, which drives setVisible below) - no IndexedDB caching like
// buildings.js has, since a network hiccup here just means temporarily-
// missing debug fills rather than anything worth persisting/falling back
// for. The underlying polygon *data* (classifyAt) is streamed unconditionally
// (not gated on that same toggle) since waterAreas.js also uses it outside
// of debug mode, to tell the splash-effect lib (lib/splash.js) whether a
// wheel is over water - so that gameplay feature works whether or not the
// player ever opens the debug overlay.
//
// Only loaded for HIGH-detail tiles (see terrain.js's HIGH_DETAIL_RADIUS/
// DetailLevel: the 3x3 block of tiles centered on the player), same as
// vectorLineLayer.js, for the same "most expensive debug content" reason.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { tileX2lon, tileY2lat, lon2tileX, lat2tileY, latLonToLocal, localToLatLon } from './geo.js';
import { getTileUrlTemplate } from './buildings.js';
import {
  DETAIL_ZOOM,
  HIGH_DETAIL_RADIUS,
  UNLOAD_MARGIN,
  UNLOAD_DELAY_TICKS,
  circleOffsets,
  inCircle,
  GROUND_COLLISION_GROUP,
} from './terrain.js';

const FETCH_TIMEOUT_MS = 15000;
const REGION_MARGIN_TILES = 2;
const REGION_RETRY_COOLDOWN_MS = 8000;
const MAX_FEATURES_PER_TILE = 8000;
const MIN_RING_POINTS = 3;
// Polygons wider than this (in meters, along either axis) are almost
// certainly bad/degenerate data at this scale (mirrors buildings.js's
// MAX_FOOTPRINT_METERS) rather than an intentionally huge real feature -
// a legitimately large lake/sea still fits comfortably under this since
// features are already clipped to one ~600-800m source tile (see module
// doc comment above).
const MAX_POLYGON_SPAN_METERS = 2000;
// Mirrors vectorLineLayer.js's per-frame/per-tile time-slicing budgets -
// see that module's doc comment for the full reasoning.
const BUILD_TIME_BUDGET_MS = 4;
const BUILD_TIME_CHECK_INTERVAL = 16;

/**
 * Standard ray-casting point-in-polygon test, run directly in lat/lon
 * space (fine at the few-km scale this is ever used at - see geo.js's own
 * doc comment on its flat-earth approximation). Used by classifyAt below
 * to test a world (x, z) position against a ring's *stored* {lat, lon}
 * points, rather than re-deriving local meters for every ring on every
 * query.
 */
function pointInLatLonRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    const intersects = pi.lat > lat !== pj.lat > lat && lon < ((pj.lon - pi.lon) * (lat - pi.lat)) / (pj.lat - pi.lat) + pi.lon;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Shoelace signed area of a ring in raw tile-pixel coordinates (sign only matters, used to classify outer-vs-hole below). */
function signedArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area;
}

/**
 * Groups a feature's raw MVT rings into polygons (outer ring + holes),
 * using the standard vector-tile convention that a ring's winding flips
 * between an exterior ring and the holes cut into it: the first ring seen
 * establishes the "outer" winding sign; any later ring sharing that sign
 * starts a new, separate exterior (a MultiPolygon), while an
 * opposite-signed ring is a hole in the most recent exterior.
 */
function classifyRings(rings) {
  const polygons = []; // [{ outer, holes: [] }]
  let outerSign = null;
  let current = null;
  for (const ring of rings) {
    if (ring.length < MIN_RING_POINTS) continue;
    const area = signedArea(ring);
    if (area === 0) continue;
    const sign = area > 0 ? 1 : -1;
    if (outerSign === null || sign === outerSign) {
      outerSign = sign;
      current = { outer: ring, holes: [] };
      polygons.push(current);
    } else if (current) {
      current.holes.push(ring);
    }
  }
  return polygons;
}

/**
 * Builds a reusable manager *class* for one vector-tile polygon layer's
 * worth of flat debug fills - see createVectorLineLayer in
 * vectorLineLayer.js (the line-feature equivalent) for the overall
 * pattern this mirrors.
 *
 * @param {object} options
 * @param {number} options.tileZoom - vector tile zoom this layer is served at.
 * @param {string} options.layerName - vector tile layer to read (e.g. 'water').
 * @param {(props: object) => ({key: string, color: number} | null)} options.classify -
 *   maps a feature's tile properties to a render style (polygons sharing the same `key` share
 *   one material/merged mesh per tile); returning null/undefined skips the feature entirely.
 * @param {number} [options.lift] - meters above sampled ground to draw the fill, avoiding z-fighting.
 * @param {number} [options.opacity] - material opacity (0..1) shared by every style this layer renders.
 */
export function createVectorPolygonLayer({ tileZoom, layerName, classify, lift = 0.3, opacity = 0.55 }) {
  const TILE_ZOOM_RATIO = 2 ** (DETAIL_ZOOM - tileZoom);
  // Style key -> MeshBasicMaterial, shared across every tile/instance of
  // this layer, same reasoning as vectorLineLayer.js's `materials` cache.
  const materials = new Map();
  function materialFor(style) {
    let mat = materials.get(style.key);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        color: style.color,
        transparent: true,
        opacity,
        // OSM polygon winding isn't guaranteed consistent, and
        // ShapeGeometry's resulting triangle winding depends on it -
        // render both faces so a reversed-winding polygon doesn't vanish
        // via backface culling (same reasoning as buildings.js's material).
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      materials.set(style.key, mat);
    }
    return mat;
  }

  /**
   * Fetches and decodes one `tileZoom` vector tile's `layerName` layer,
   * returning its polygons (each tagged with its resolved style) bucketed
   * by which DETAIL_ZOOM tile each polygon's outer-ring centroid falls in.
   */
  async function fetchTile(tx, ty) {
    const template = await getTileUrlTemplate();
    const url = template.replace('{z}', tileZoom).replace('{x}', tx).replace('{y}', ty);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let buffer;
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 404) return new Map();
      if (!res.ok) throw new Error(`Tile request failed (${res.status})`);
      buffer = await res.arrayBuffer();
    } finally {
      clearTimeout(timer);
    }

    const tile = new VectorTile(new PbfReader(new Uint8Array(buffer)));
    const layer = tile.layers[layerName];
    const byTile = new Map();
    if (!layer) return byTile;

    const featureCount = Math.min(layer.length, MAX_FEATURES_PER_TILE);
    for (let i = 0; i < featureCount; i++) {
      try {
        const feature = layer.feature(i);
        const style = classify(feature.properties);
        if (!style) continue;
        const extent = layer.extent;
        const rings = feature.loadGeometry(); // array of point-arrays, raw tile-pixel coords
        const polygons = classifyRings(rings);
        for (const { outer, holes } of polygons) {
          const toLatLon = (ring) =>
            ring.map((p) => ({
              lat: tileY2lat(ty + p.y / extent, tileZoom),
              lon: tileX2lon(tx + p.x / extent, tileZoom),
            }));
          const outerLatLon = toLatLon(outer);
          let sumLat = 0;
          let sumLon = 0;
          for (const p of outerLatLon) {
            sumLat += p.lat;
            sumLon += p.lon;
          }
          const centroidLat = sumLat / outerLatLon.length;
          const centroidLon = sumLon / outerLatLon.length;
          const detailTx = Math.floor(lon2tileX(centroidLon, DETAIL_ZOOM));
          const detailTy = Math.floor(lat2tileY(centroidLat, DETAIL_ZOOM));
          const key = `${detailTx}_${detailTy}`;
          let list = byTile.get(key);
          if (!list) {
            list = [];
            byTile.set(key, list);
          }
          list.push({ outer: outerLatLon, holes: holes.map(toLatLon), style });
        }
      } catch (err) {
        console.warn(`Skipping one malformed ${layerName} feature`, tx, ty, err);
      }
    }
    return byTile;
  }

  return class VectorPolygonLayerManager {
    constructor(scene, world, originLat, originLon) {
      this.scene = scene;
      this.world = world;
      this.originLat = originLat;
      this.originLon = originLon;
      this.chunks = new Map(); // key -> { meshes: THREE.Mesh[], tx, ty }
      this.pendingRemoval = new Map();
      this._visible = false;
      this._buildQueue = []; // [{ tx, ty, key }]
      this._queuedKeys = new Set();
      this._inProgressBuilds = new Map(); // key -> build descriptor, paused mid-tile

      this._region = null; // { minTx, maxTx, minTy, maxTy }
      this._polygonsByTile = new Map(); // tileKey -> [{ outer, holes, style }]
      this._regionPending = null;
      this._regionFailedAt = 0;
      this._generation = 0;
    }

    _key(tx, ty) {
      return `${tx}_${ty}`;
    }

    _keepRadius() {
      return HIGH_DETAIL_RADIUS + UNLOAD_MARGIN;
    }

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

    /** Mirrors VectorLineLayerManager._ensureRegion (see vectorLineLayer.js) - no IndexedDB cache fallback here either. */
    async _ensureRegion(centerTx, centerTy) {
      if (this._regionCovers(centerTx, centerTy)) return;
      if (this._regionPending) {
        await this._regionPending.catch(() => {});
        if (this._regionCovers(centerTx, centerTy)) return;
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
      } catch (err) {
        console.warn(`${layerName} region fetch failed, will retry shortly`, err);
        this._regionFailedAt = Date.now();
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

      const results = await Promise.allSettled(tileCoords.map(([tx14, ty14]) => fetchTile(tx14, ty14)));
      if (generation !== this._generation) return;

      const byTile = new Map();
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
        }
      }
      if (tileCoords.length > 0 && failed === tileCoords.length) {
        throw new Error(`All ${failed} ${layerName} tile request(s) failed`);
      }

      this._region = region;
      this._polygonsByTile = byTile;
    }

    /** Same ground-height raycast approach as BuildingsManager._groundHeightAt. */
    _groundHeightAt(x, z) {
      const from = new CANNON.Vec3(x, 2000, z);
      const to = new CANNON.Vec3(x, -2000, z);
      const result = new CANNON.RaycastResult();
      this.world.raycastClosest(from, to, { collisionFilterMask: GROUND_COLLISION_GROUP }, result);
      return result.hasHit ? result.hitPointWorld.y : 0;
    }

    _beginChunkBuild(tx, ty) {
      const key = this._key(tx, ty);
      return {
        tx,
        ty,
        key,
        list: this._polygonsByTile.get(key) || [],
        index: 0,
        byStyleKey: new Map(), // style.key -> { style, geometries: THREE.BufferGeometry[] }
      };
    }

    /** Mirrors vectorLineLayer.js's _stepChunkBuild - see that module for the time-slicing rationale. */
    _stepChunkBuild(build, deadline) {
      const { list, byStyleKey } = build;
      let sinceCheck = 0;
      while (build.index < list.length) {
        if (sinceCheck >= BUILD_TIME_CHECK_INTERVAL) {
          if (performance.now() >= deadline) return false;
          sinceCheck = 0;
        }
        sinceCheck++;
        const entry = list[build.index++];
        try {
          const outerPts = entry.outer.map((p) => latLonToLocal(p.lat, p.lon, this.originLat, this.originLon));
          if (outerPts.length < MIN_RING_POINTS) continue;

          let minX = Infinity;
          let maxX = -Infinity;
          let minZ = Infinity;
          let maxZ = -Infinity;
          for (const p of outerPts) {
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minZ = Math.min(minZ, p.z);
            maxZ = Math.max(maxZ, p.z);
          }
          if (maxX - minX > MAX_POLYGON_SPAN_METERS || maxZ - minZ > MAX_POLYGON_SPAN_METERS) continue;

          // Same (x, -z) + rotateX(-90deg) convention buildings.js uses to
          // map a flat THREE.Shape into the world's X/Z ground plane - see
          // buildFootprintGeometry's doc comment in buildings.js.
          const shape = new THREE.Shape();
          outerPts.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, -p.z) : shape.lineTo(p.x, -p.z)));
          for (const hole of entry.holes) {
            const holePts = hole.map((p) => latLonToLocal(p.lat, p.lon, this.originLat, this.originLon));
            if (holePts.length < MIN_RING_POINTS) continue;
            const path = new THREE.Path();
            holePts.forEach((p, i) => (i === 0 ? path.moveTo(p.x, -p.z) : path.lineTo(p.x, -p.z)));
            shape.holes.push(path);
          }

          const geometry = new THREE.ShapeGeometry(shape);
          geometry.rotateX(-Math.PI / 2);
          const centerX = (minX + maxX) / 2;
          const centerZ = (minZ + maxZ) / 2;
          const groundY = this._groundHeightAt(centerX, centerZ) + lift;
          geometry.translate(0, groundY, 0);

          let bucket = byStyleKey.get(entry.style.key);
          if (!bucket) {
            bucket = { style: entry.style, geometries: [] };
            byStyleKey.set(entry.style.key, bucket);
          }
          bucket.geometries.push(geometry);
        } catch (err) {
          console.warn(`Skipping one malformed ${layerName} polygon`, build.tx, build.ty, err);
        }
      }
      return true;
    }

    /** Finalizes a fully-processed build descriptor into a chunk in `this.chunks`. */
    _finishChunkBuild(build) {
      const { tx, ty, key, byStyleKey } = build;
      const meshes = [];
      for (const bucket of byStyleKey.values()) {
        if (!bucket.geometries.length) continue;
        const merged =
          bucket.geometries.length > 1 ? mergeGeometries(bucket.geometries, false) : bucket.geometries[0];
        if (bucket.geometries.length > 1) {
          for (const g of bucket.geometries) g.dispose();
        }
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, materialFor(bucket.style));
        mesh.visible = this._visible;
        this.scene.add(mesh);
        meshes.push(mesh);
      }
      this.chunks.set(key, { meshes, tx, ty });
    }

    /** Discards a build descriptor paused mid-tile - no meshes exist yet, so there's nothing to dispose, just drop it. */
    _abandonChunkBuild() {}

    /** True once a tile's fills have actually been built (not just fetched) - used by the debug stats HUD's per-tile progress indicator. */
    isTileLoaded(tx, ty) {
      return this.chunks.has(this._key(tx, ty));
    }

    /**
     * Tests a world (x, z) position against this layer's already-fetched
     * polygon data (see _polygonsByTile above) and returns the matching
     * style's `key` (e.g. 'water'), or null if the point falls outside
     * every polygon - used by hud/suspensionHud.js's terrain-type square,
     * so a wheel can be classified as "over water" without waiting for
     * (or caring about) whether that tile's debug fill mesh has actually
     * finished building yet. Checks the containing DETAIL_ZOOM tile plus
     * its 8 neighbors since a polygon is bucketed by its *centroid*'s tile
     * (see fetchTile above) but can still extend into an adjacent one.
     * Independent of `_visible` (see module doc comment) - works whether
     * or not the debug fill mesh itself is being shown.
     */
    classifyAt(x, z) {
      const { lat, lon } = localToLatLon(x, z, this.originLat, this.originLon);
      const tx = Math.floor(lon2tileX(lon, DETAIL_ZOOM));
      const ty = Math.floor(lat2tileY(lat, DETAIL_ZOOM));
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const list = this._polygonsByTile.get(`${tx + dx}_${ty + dy}`);
          if (!list) continue;
          for (const entry of list) {
            if (!pointInLatLonRing(lat, lon, entry.outer)) continue;
            if (entry.holes.some((hole) => pointInLatLonRing(lat, lon, hole))) continue;
            return entry.style.key;
          }
        }
      }
      return null;
    }

    _unloadChunk(key) {
      const chunk = this.chunks.get(key);
      if (!chunk) return;
      for (const mesh of chunk.meshes) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
      }
      this.chunks.delete(key);
      this.pendingRemoval.delete(key);
    }

    /** Toggles visibility of every currently-loaded fill (see main.js's M-key debug toggle). */
    setVisible(visible) {
      this._visible = visible;
      for (const chunk of this.chunks.values()) {
        for (const mesh of chunk.meshes) mesh.visible = visible;
      }
    }

    /** Mirrors BuildingsManager.recenter - see that module for the full reasoning. */
    recenter(lat, lon) {
      for (const key of Array.from(this.chunks.keys())) this._unloadChunk(key);
      this.pendingRemoval.clear();
      this._buildQueue = [];
      this._queuedKeys.clear();
      this._inProgressBuilds.clear();
      this._region = null;
      this._polygonsByTile = new Map();
      this._regionPending = null;
      this._regionFailedAt = 0;
      this._generation++;
      this.originLat = lat;
      this.originLon = lon;
    }

    /**
     * Mirrors BuildingsManager.update/VectorLineLayerManager.update - see
     * those for the full reasoning. Unlike those (and unlike this same
     * class's own mesh visibility), this always fetches/builds regardless
     * of `_visible` - see module doc comment on why the polygon data needs
     * to be available for classifyAt even when the debug fill is hidden.
     */
    async update(centerTx, centerTy, awaitAll = false) {
      const ensure = this._ensureRegion(centerTx, centerTy);
      if (awaitAll) await ensure;
      else ensure.catch(() => {});

      const keepRadius = this._keepRadius();

      if (this._regionCovers(centerTx, centerTy)) {
        for (const { dx, dy } of circleOffsets(HIGH_DETAIL_RADIUS)) {
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
  };
}
