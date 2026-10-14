// Base class for debug overlays streamed from OpenFreeMap vector tiles
// (streets, rivers, water areas). Handles region fetch + MVT decode,
// bucketing items into DETAIL_ZOOM tiles, time-sliced mesh building,
// delayed unload, recenter and visibility. Subclasses implement:
//   _decodeFeature(geometry, style, toLatLon, add) - add(lat, lon, item) buckets
//       an item by the detail tile containing (lat, lon); item must carry `style`.
//   _buildItem(item, byStyleKey) - turn one item into per-style bucket data.
//   _makeMesh(bucket) - build a mesh from one finished bucket (or null).
// Only the HIGH_DETAIL_RADIUS block around the player is loaded - these are
// the most expensive debug content. No IndexedDB cache (unlike buildings.js).

import * as CANNON from 'cannon-es';
import { tileX2lon, tileY2lat, lon2tileX, lat2tileY } from '../geo.js';
import { fetchVectorTileLayer } from './openFreeMap.js';
import {
  DETAIL_ZOOM,
  HIGH_DETAIL_RADIUS,
  UNLOAD_MARGIN,
  UNLOAD_DELAY_TICKS,
  circleOffsets,
  inCircle,
  GROUND_COLLISION_GROUP,
} from '../terrain.js';

const REGION_MARGIN_TILES = 2;
const REGION_RETRY_COOLDOWN_MS = 8000;
const MAX_FEATURES_PER_TILE = 8000;
const BUILD_TIME_BUDGET_MS = 4; // per frame, so a fresh region doesn't stutter
const BUILD_TIME_CHECK_INTERVAL = 16; // items between performance.now() checks

export function tileKey(tx, ty) {
  return `${tx}_${ty}`;
}

export class VectorTileLayer {
  /**
   * @param {object} opts
   * @param {number} opts.tileZoom - zoom the vector tiles are served at.
   * @param {string} opts.layerName - MVT layer to read ('transportation', 'water', ...).
   * @param {(props: object) => ({key: string} | null)} opts.classify - feature props -> style, null skips.
   * @param {boolean} [opts.alwaysStream] - stream data even while hidden (gameplay uses it).
   */
  constructor(scene, world, originLat, originLon, { tileZoom, layerName, classify, alwaysStream = false }) {
    this.scene = scene;
    this.world = world;
    this.originLat = originLat;
    this.originLon = originLon;
    this.scaleLat = originLat; // see geo.js; kept by shiftOrigin()
    this.tileZoom = tileZoom;
    this.layerName = layerName;
    this.classify = classify;
    this.alwaysStream = alwaysStream;
    this.tileZoomRatio = 2 ** (DETAIL_ZOOM - tileZoom);

    this.chunks = new Map(); // key -> { meshes, tx, ty }
    this.pendingRemoval = new Map(); // key -> ticks left
    this._visible = false;
    this._buildQueue = []; // [{ tx, ty, key }]
    this._queuedKeys = new Set();
    this._inProgressBuilds = new Map(); // key -> build descriptor paused mid-tile

    this._region = null; // { minTx, maxTx, minTy, maxTy }
    this._itemsByTile = new Map(); // detail tile key -> items
    this._regionPending = null;
    this._regionFailedAt = 0;
    this._generation = 0;
  }

  _key(tx, ty) {
    return tileKey(tx, ty);
  }

  _keepRadius() {
    return HIGH_DETAIL_RADIUS + UNLOAD_MARGIN;
  }

  /** Items whose bucket tile is within one tile of the detail tile containing (lat, lon). */
  *_itemsNear(lat, lon) {
    const tx = Math.floor(lon2tileX(lon, DETAIL_ZOOM));
    const ty = Math.floor(lat2tileY(lat, DETAIL_ZOOM));
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this._itemsByTile.get(tileKey(tx + dx, ty + dy));
        if (list) yield* list;
      }
    }
  }

  /** Fetches one vector tile and returns its items bucketed by detail tile key. */
  async _fetchTile(tx, ty) {
    const { tileZoom, layerName } = this;
    const layer = await fetchVectorTileLayer(tileZoom, tx, ty, layerName);
    const byTile = new Map();
    if (!layer) return byTile;

    const extent = layer.extent;
    const toLatLon = (p) => ({
      lat: tileY2lat(ty + p.y / extent, tileZoom),
      lon: tileX2lon(tx + p.x / extent, tileZoom),
    });
    const add = (lat, lon, item) => {
      const key = tileKey(Math.floor(lon2tileX(lon, DETAIL_ZOOM)), Math.floor(lat2tileY(lat, DETAIL_ZOOM)));
      let list = byTile.get(key);
      if (!list) byTile.set(key, (list = []));
      list.push(item);
    };

    const featureCount = Math.min(layer.length, MAX_FEATURES_PER_TILE);
    for (let i = 0; i < featureCount; i++) {
      try {
        const feature = layer.feature(i);
        const style = this.classify(feature.properties);
        if (!style) continue;
        this._decodeFeature(feature.loadGeometry(), style, toLatLon, add);
      } catch (err) {
        console.warn(`Skipping one malformed ${layerName} feature`, tx, ty, err);
      }
    }
    return byTile;
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

  /** Fetches a region around the player if the current one doesn't cover it (with retry cooldown). */
  async _ensureRegion(centerTx, centerTy) {
    if (this._regionCovers(centerTx, centerTy)) return;
    if (this._regionPending) {
      await this._regionPending.catch(() => {});
      if (this._regionCovers(centerTx, centerTy)) return;
    }
    if (this._regionFailedAt && Date.now() - this._regionFailedAt < REGION_RETRY_COOLDOWN_MS) return;

    const r = this._keepRadius() + REGION_MARGIN_TILES;
    const region = { minTx: centerTx - r, maxTx: centerTx + r, minTy: centerTy - r, maxTy: centerTy + r };
    const promise = this._fetchRegion(region, this._generation);
    this._regionPending = promise;
    try {
      await promise;
      this._regionFailedAt = 0;
    } catch (err) {
      console.warn(`${this.layerName} region fetch failed, will retry shortly`, err);
      this._regionFailedAt = Date.now();
    } finally {
      if (this._regionPending === promise) this._regionPending = null;
    }
  }

  async _fetchRegion(region, generation) {
    const ratio = this.tileZoomRatio;
    const tileCoords = [];
    for (let tx = Math.floor(region.minTx / ratio); tx <= Math.floor(region.maxTx / ratio); tx++) {
      for (let ty = Math.floor(region.minTy / ratio); ty <= Math.floor(region.maxTy / ratio); ty++) {
        tileCoords.push([tx, ty]);
      }
    }

    const results = await Promise.allSettled(tileCoords.map(([tx, ty]) => this._fetchTile(tx, ty)));
    if (generation !== this._generation) return; // recentered meanwhile

    const byTile = new Map();
    let failed = 0;
    for (const result of results) {
      if (result.status === 'rejected') {
        failed++;
        continue;
      }
      for (const [key, list] of result.value) {
        let existing = byTile.get(key);
        if (!existing) byTile.set(key, (existing = []));
        existing.push(...list);
      }
    }
    if (tileCoords.length > 0 && failed === tileCoords.length) {
      throw new Error(`All ${failed} ${this.layerName} tile request(s) failed`);
    }

    this._region = region;
    this._itemsByTile = byTile;
  }

  _groundHeightAt(x, z) {
    const from = new CANNON.Vec3(x, 2000, z);
    const to = new CANNON.Vec3(x, -2000, z);
    const result = new CANNON.RaycastResult();
    this.world.raycastClosest(from, to, { collisionFilterMask: GROUND_COLLISION_GROUP }, result);
    return result.hasHit ? result.hitPointWorld.y : 0;
  }

  /** Per-style bucket in a build, created with `init()` on first use. */
  _bucket(byStyleKey, style, init) {
    let bucket = byStyleKey.get(style.key);
    if (!bucket) byStyleKey.set(style.key, (bucket = { style, ...init() }));
    return bucket;
  }

  _beginChunkBuild(tx, ty) {
    const key = this._key(tx, ty);
    return { tx, ty, key, list: this._itemsByTile.get(key) || [], index: 0, byStyleKey: new Map() };
  }

  /** Resumable: processes items until done (true) or past `deadline` (false). */
  _stepChunkBuild(build, deadline) {
    const { list, byStyleKey } = build;
    let sinceCheck = 0;
    while (build.index < list.length) {
      if (sinceCheck >= BUILD_TIME_CHECK_INTERVAL) {
        if (performance.now() >= deadline) return false;
        sinceCheck = 0;
      }
      sinceCheck++;
      const item = list[build.index++];
      try {
        this._buildItem(item, byStyleKey);
      } catch (err) {
        console.warn(`Skipping one malformed ${this.layerName} item`, build.tx, build.ty, err);
      }
    }
    return true;
  }

  _finishChunkBuild({ tx, ty, key, byStyleKey }) {
    const meshes = [];
    for (const bucket of byStyleKey.values()) {
      const mesh = this._makeMesh(bucket);
      if (!mesh) continue;
      mesh.visible = this._visible;
      this.scene.add(mesh);
      meshes.push(mesh);
    }
    this.chunks.set(key, { meshes, tx, ty });
  }

  /** True once a tile's meshes are built (not just fetched) - for the debug stats HUD. */
  isTileLoaded(tx, ty) {
    return this.chunks.has(this._key(tx, ty));
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

  /** M-key debug toggle. */
  setVisible(visible) {
    this._visible = visible;
    for (const chunk of this.chunks.values()) {
      for (const mesh of chunk.meshes) mesh.visible = visible;
    }
  }

  recenter(lat, lon) {
    for (const key of Array.from(this.chunks.keys())) this._unloadChunk(key);
    this.pendingRemoval.clear();
    this._buildQueue = [];
    this._queuedKeys.clear();
    this._inProgressBuilds.clear();
    this._region = null;
    this._itemsByTile = new Map();
    this._regionPending = null;
    this._regionFailedAt = 0;
    this._generation++;
    this.originLat = lat;
    this.originLon = lon;
    this.scaleLat = lat;
  }

  /**
   * Floating-origin shift by (dx, dz): scene objects were already translated
   * by the caller; partial builds' buckets are moved via _shiftBucket().
   */
  shiftOrigin(lat, lon, dx, dz) {
    this.originLat = lat;
    this.originLon = lon;
    for (const build of this._inProgressBuilds.values()) {
      for (const bucket of build.byStyleKey.values()) this._shiftBucket(bucket, dx, dz);
    }
  }

  /** Streams around (centerTx, centerTy); builds are time-sliced unless `awaitAll`. */
  async update(centerTx, centerTy, awaitAll = false) {
    if (!this.alwaysStream && !this._visible) return;

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
    // Finish tiles paused mid-build before starting new ones.
    for (const [key, build] of this._inProgressBuilds) {
      if (performance.now() >= deadline) break;
      if (!inCircle(build.tx - centerTx, build.ty - centerTy, keepRadius)) {
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
      if (!inCircle(chunk.tx - centerTx, chunk.ty - centerTy, keepRadius)) {
        if (!this.pendingRemoval.has(k)) this.pendingRemoval.set(k, UNLOAD_DELAY_TICKS);
      } else {
        this.pendingRemoval.delete(k);
      }
    }
    for (const [k, ticksLeft] of this.pendingRemoval) {
      if (ticksLeft <= 1) this._unloadChunk(k);
      else this.pendingRemoval.set(k, ticksLeft - 1);
    }
  }
}
