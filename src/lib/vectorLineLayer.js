// Shared streaming/rendering engine behind both streets.js and rivers.js:
// decodes line-geometry features (OSM roads, or OSM rivers/waterways) from
// OpenFreeMap's vector tiles (the same tiles buildings.js reads its
// `building` layer from - see that module's doc comment for why
// OpenFreeMap over a live Overpass query) and renders them as broad "fat"
// debug lines hovering just above the terrain, streamed on the same
// DETAIL_ZOOM tile grid as terrain.js/buildings.js.
//
// Bucketed per *segment* (consecutive point pair), not per whole feature -
// a single OSM way can easily span many DETAIL_ZOOM tiles (each covering
// only ~600-800m), so centroid-bucketing a whole way (fine for
// buildings.js's much smaller footprints) would make long roads/rivers pop
// in/out as one unit instead of streaming smoothly tile-by-tile.
//
// This is a cosmetic debug overlay only (see debugVisuals.js's M-key
// toggle) - no physics, no IndexedDB caching like buildings.js has, since
// a network hiccup here just means temporarily-missing debug lines rather
// than anything worth persisting/falling back for.
//
// Only loaded for HIGH-detail tiles (see terrain.js's HIGH_DETAIL_RADIUS/
// DetailLevel: the 3x3 block of tiles centered on the player) rather than
// the whole detail tier buildings.js/terrain.js stream - these vector-tile
// fetches + per-segment decode are the most expensive debug content here,
// so they're kept to just the handful of tiles actually worth the detail.

import * as CANNON from 'cannon-es';
import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, DoubleSide } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
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
// Per-frame time budget (ms) spent building already-fetched tiles into line
// meshes - mirrors buildings.js's BUILD_TIME_BUDGET_MS (see its doc
// comment): a newly-available region can make several tiles buildable in
// the same frame, and each one does a ground raycast per segment, so this
// spreads that work across frames instead of risking a stutter.
const BUILD_TIME_BUDGET_MS = 4;
// How many segments to process between performance.now() checks within a
// single tile's build (see _stepChunkBuild) - mirrors buildings.js's
// BUILD_TIME_CHECK_INTERVAL. A dense city tile's street/river network can
// have thousands of segments (each costing two ground raycasts), so a
// single tile's build must itself be resumable across frames, not just
// budgeted tile-by-tile - otherwise one especially dense tile could still
// blow straight through the whole per-frame budget in one go.
const BUILD_TIME_CHECK_INTERVAL = 16;

/**
 * Builds a reusable manager *class* (not an instance - call `new` on the
 * return value, same as importing a class directly) for one vector tile
 * layer's worth of debug lines. Kept as a factory (rather than one big
 * configurable class) so each of streets.js/rivers.js gets its own
 * private `materials` cache, closed over by the class's methods, without
 * either module needing to know the other exists.
 *
 * @param {object} options
 * @param {number} options.tileZoom - vector tile zoom this layer is served at (same as buildings.js's BUILDING_TILE_ZOOM)
 * @param {string} options.layerName - vector tile layer to read ('transportation', 'waterway', ...)
 * @param {(props: object) => ({key: string, color: number, linewidth: number} | null)} options.classify -
 *   maps a feature's tile properties to a render style (segments sharing
 *   the same `key` share one LineMaterial/mesh per tile); returning
 *   null/undefined skips the feature entirely.
 * @param {number} [options.lift] - meters above sampled ground to draw the line, avoiding z-fighting.
 * @param {boolean} [options.flat] - when true, each style's `linewidth` is a real-world-meters
 *   stripe drawn as a flat quad lying in the ground's XZ plane (e.g. streets.js's per-road-class
 *   widths), instead of the default LineMaterial "fat line" (screen-space-width, always facing the
 *   camera - fine for rivers' thin debug traces, but reads as sprite-like billboards rather than a
 *   stripe actually lying on the ground once the line gets wide).
 */
export function createVectorLineLayer({ tileZoom, layerName, classify, lift = 0.2, flat = false }) {
  const TILE_ZOOM_RATIO = 2 ** (DETAIL_ZOOM - tileZoom);
  // Style key -> material (LineMaterial, or MeshBasicMaterial when `flat`),
  // shared across every tile/instance of this layer so e.g. every
  // "motorway" segment anywhere reuses one material instead of allocating
  // a new GPU program per tile.
  const materials = new Map();
  function materialFor(style) {
    let mat = materials.get(style.key);
    if (!mat) {
      if (flat) {
        mat = new MeshBasicMaterial({ color: style.color, transparent: true, opacity: 0.85, side: DoubleSide });
      } else {
        mat = new LineMaterial({ color: style.color, linewidth: style.linewidth, transparent: true, opacity: 0.85 });
        mat.resolution.set(window.innerWidth, window.innerHeight);
      }
      materials.set(style.key, mat);
    }
    return mat;
  }
  window.addEventListener('resize', () => {
    for (const mat of materials.values()) {
      if (mat.resolution) mat.resolution.set(window.innerWidth, window.innerHeight);
    }
  });

  /**
   * Fetches and decodes one `tileZoom` vector tile's `layerName` layer,
   * returning its line segments (pairs of {lat, lon} points, each tagged
   * with its resolved style) bucketed by which DETAIL_ZOOM tile each
   * segment's midpoint falls in.
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
        const lines = feature.loadGeometry(); // array of point-arrays, one per LineString part
        for (const line of lines) {
          if (line.length < 2) continue;
          const points = line.map((p) => ({
            lat: tileY2lat(ty + p.y / extent, tileZoom),
            lon: tileX2lon(tx + p.x / extent, tileZoom),
          }));
          for (let p = 0; p < points.length - 1; p++) {
            const a = points[p];
            const b = points[p + 1];
            const midLat = (a.lat + b.lat) / 2;
            const midLon = (a.lon + b.lon) / 2;
            const detailTx = Math.floor(lon2tileX(midLon, DETAIL_ZOOM));
            const detailTy = Math.floor(lat2tileY(midLat, DETAIL_ZOOM));
            const key = `${detailTx}_${detailTy}`;
            let list = byTile.get(key);
            if (!list) {
              list = [];
              byTile.set(key, list);
            }
            list.push({ a, b, style });
          }
        }
      } catch (err) {
        console.warn(`Skipping one malformed ${layerName} feature`, tx, ty, err);
      }
    }
    return byTile;
  }

  return class VectorLineLayerManager {
    constructor(scene, world, originLat, originLon) {
      this.scene = scene;
      this.world = world;
      this.originLat = originLat;
      this.originLon = originLon;
      this.chunks = new Map(); // key -> { lines: THREE.Object3D[], tx, ty }
      this.pendingRemoval = new Map();
      this._visible = false;
      // Time-sliced build queue (see BUILD_TIME_BUDGET_MS above) - tiles
      // whose segments are fetched but not yet built into line meshes.
      this._buildQueue = []; // [{ tx, ty, key }]
      this._queuedKeys = new Set();
      this._inProgressBuilds = new Map(); // key -> build descriptor (see _beginChunkBuild), paused mid-tile

      this._region = null; // { minTx, maxTx, minTy, maxTy }
      this._segmentsByTile = new Map(); // tileKey -> [{a:{lat,lon}, b:{lat,lon}, style}]
      this._regionPending = null;
      this._regionFailedAt = 0;
      this._generation = 0;
    }

    _key(tx, ty) {
      return `${tx}_${ty}`;
    }

    _keepRadius() {
      // HIGH_DETAIL_RADIUS (the 3x3 block), not the whole detail tier's
      // DETAIL_RADIUS - see the module doc comment above.
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

    /** Mirrors BuildingsManager._ensureRegion (see buildings.js) - no IndexedDB cache fallback here, see module doc comment. */
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
      this._segmentsByTile = byTile;
    }

    /** Same ground-height raycast approach as BuildingsManager._groundHeightAt. */
    _groundHeightAt(x, z) {
      const from = new CANNON.Vec3(x, 2000, z);
      const to = new CANNON.Vec3(x, -2000, z);
      const result = new CANNON.RaycastResult();
      this.world.raycastClosest(from, to, { collisionFilterMask: GROUND_COLLISION_GROUP }, result);
      return result.hasHit ? result.hitPointWorld.y : 0;
    }

    /**
     * Starts a new time-sliced build for one tile from the already-fetched
     * segment cache (no network I/O) - returns a resumable "build
     * descriptor" consumed by _stepChunkBuild/_finishChunkBuild rather than
     * doing all the work here, so a dense city tile's worth of segments
     * never has to finish in a single frame (see BUILD_TIME_BUDGET_MS/
     * BUILD_TIME_CHECK_INTERVAL above).
     */
    _beginChunkBuild(tx, ty) {
      const key = this._key(tx, ty);
      return {
        tx,
        ty,
        key,
        list: this._segmentsByTile.get(key) || [],
        index: 0,
        byStyleKey: new Map(), // style.key -> { style, positions: number[] }
      };
    }

    /**
     * Processes segments from a build descriptor (see _beginChunkBuild)
     * starting at `build.index`, stopping either when the tile's whole list
     * is done or when `deadline` (a performance.now() timestamp) is
     * reached - whichever comes first. Safe to call again on the same
     * descriptor next frame to resume exactly where it left off. Returns
     * true once the tile is fully processed (ready for _finishChunkBuild),
     * false if paused.
     */
    _stepChunkBuild(build, deadline) {
      const { list, byStyleKey } = build;
      let sinceCheck = 0;
      while (build.index < list.length) {
        if (sinceCheck >= BUILD_TIME_CHECK_INTERVAL) {
          if (performance.now() >= deadline) return false;
          sinceCheck = 0;
        }
        sinceCheck++;
        const seg = list[build.index++];
        try {
          const a = latLonToLocal(seg.a.lat, seg.a.lon, this.originLat, this.originLon);
          const b = latLonToLocal(seg.b.lat, seg.b.lon, this.originLat, this.originLon);
          const ay = this._groundHeightAt(a.x, a.z) + lift;
          const by = this._groundHeightAt(b.x, b.z) + lift;
          let bucket = byStyleKey.get(seg.style.key);
          if (!bucket) {
            bucket = { style: seg.style, positions: [] };
            byStyleKey.set(seg.style.key, bucket);
          }
          if (flat) {
            // Flat ground-hugging quad: offset each endpoint sideways in the
            // XZ plane only (not toward the camera, unlike LineMaterial's
            // fat lines below) so the stripe actually lies on the terrain
            // instead of billboarding - see `flat` option doc comment above.
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const len = Math.hypot(dx, dz);
            // Degenerate (near-zero-length) segment: no well-defined
            // direction to offset perpendicular to, so fall back to an
            // arbitrary sideways axis rather than dividing by ~0.
            const nx = len > 1e-6 ? -dz / len : 1;
            const nz = len > 1e-6 ? dx / len : 0;
            const hw = seg.style.linewidth / 2;
            const ox = nx * hw;
            const oz = nz * hw;
            // Two triangles covering the quad [a-off, a+off, b-off, b+off].
            bucket.positions.push(
              a.x - ox, ay, a.z - oz,
              a.x + ox, ay, a.z + oz,
              b.x + ox, by, b.z + oz,
              a.x - ox, ay, a.z - oz,
              b.x + ox, by, b.z + oz,
              b.x - ox, by, b.z - oz,
            );
          } else {
            bucket.positions.push(a.x, ay, a.z, b.x, by, b.z);
          }
        } catch (err) {
          console.warn(`Skipping one malformed ${layerName} segment`, build.tx, build.ty, err);
        }
      }
      return true;
    }

    /** Finalizes a fully-processed build descriptor (see _stepChunkBuild) into a chunk in `this.chunks`. */
    _finishChunkBuild(build) {
      const { tx, ty, key, byStyleKey } = build;
      const lines = [];
      for (const bucket of byStyleKey.values()) {
        let mesh;
        if (flat) {
          const geometry = new BufferGeometry();
          geometry.setAttribute('position', new Float32BufferAttribute(bucket.positions, 3));
          mesh = new Mesh(geometry, materialFor(bucket.style));
        } else {
          const geometry = new LineSegmentsGeometry();
          geometry.setPositions(bucket.positions);
          mesh = new LineSegments2(geometry, materialFor(bucket.style));
        }
        mesh.visible = this._visible;
        this.scene.add(mesh);
        lines.push(mesh);
      }
      this.chunks.set(key, { lines, tx, ty });
    }

    /** Discards a build descriptor that's paused mid-tile (see _stepChunkBuild) - no meshes exist yet, so there's nothing to dispose, just drop it. */
    _abandonChunkBuild() {}

    /** True once a tile's line meshes have actually been built (not just fetched) - used by the debug stats HUD's per-tile progress indicator. */
    isTileLoaded(tx, ty) {
      return this.chunks.has(this._key(tx, ty));
    }

    /**
     * Tests whether a world (x, z) position falls within any `flat`
     * stripe's real-world half-width of its segment (the exact same
     * half-width the ground-hugging quad in _stepChunkBuild is actually
     * drawn with) - used by hud/suspensionHud.js's terrain-type square to
     * tell "on the road" apart from "off to the side of it", without
     * waiting for that tile's mesh to finish building. Only meaningful
     * for `flat` layers (streets.js's real-meter road widths); non-flat
     * layers (rivers.js's screen-space fat lines) have no well-defined
     * real-world width to test against, so this always returns false for
     * those rather than guessing one.
     */
    containsPoint(x, z) {
      if (!flat || !this._visible) return false;
      const { lat, lon } = localToLatLon(x, z, this.originLat, this.originLon);
      const tx = Math.floor(lon2tileX(lon, DETAIL_ZOOM));
      const ty = Math.floor(lat2tileY(lat, DETAIL_ZOOM));
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const list = this._segmentsByTile.get(`${tx + dx}_${ty + dy}`);
          if (!list) continue;
          for (const seg of list) {
            const a = latLonToLocal(seg.a.lat, seg.a.lon, this.originLat, this.originLon);
            const b = latLonToLocal(seg.b.lat, seg.b.lon, this.originLat, this.originLon);
            const abx = b.x - a.x;
            const abz = b.z - a.z;
            const lenSq = abx * abx + abz * abz;
            const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / lenSq)) : 0;
            const px = a.x + abx * t;
            const pz = a.z + abz * t;
            const dist = Math.hypot(x - px, z - pz);
            if (dist <= seg.style.linewidth / 2) return true;
          }
        }
      }
      return false;
    }

    _unloadChunk(key) {
      const chunk = this.chunks.get(key);
      if (!chunk) return;
      for (const mesh of chunk.lines) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
      }
      this.chunks.delete(key);
      this.pendingRemoval.delete(key);
    }

    /** Toggles visibility of every currently-loaded line (see main.js's M-key debug toggle). */
    setVisible(visible) {
      this._visible = visible;
      for (const chunk of this.chunks.values()) {
        for (const mesh of chunk.lines) mesh.visible = visible;
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
      this._segmentsByTile = new Map();
      this._regionPending = null;
      this._regionFailedAt = 0;
      this._generation++;
      this.originLat = lat;
      this.originLon = lon;
    }

    /**
     * Mirrors BuildingsManager.update - see that module for the full
     * reasoning, including why tile building is time-sliced (budgeted
     * across frames via `awaitAll ? Infinity : BUILD_TIME_BUDGET_MS`
     * rather than all done in the frame a region fetch resolves in).
     */
    async update(centerTx, centerTy, awaitAll = false) {
      // No point paying for the network fetch/tile build at all while the
      // overlay is hidden - just like terrain.js's borders/buildings'
      // hitboxes, this is purely cosmetic debug output.
      if (!this._visible) return;

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
        if (this.chunks.has(key)) continue; // already built
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
  };
}
