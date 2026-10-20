// Base class for debug overlays streamed from OpenFreeMap vector tiles
// (streets, rivers, water areas). Handles region fetch + MVT decode,
// bucketing items into DETAIL_ZOOM tiles, time-sliced mesh building,
// delayed unload, recenter and visibility. Subclasses implement:
//   _decodeFeature(geometry, style, toLatLon, add, extent) - add(lat, lon, item) buckets
//       an item by the detail tile containing (lat, lon); item must carry `style`.
//   _buildItem(item, byStyleKey) - turn one item into per-style bucket data.
//   _makeMesh(bucket) - build a mesh from one finished bucket (or null).
// By default only the HIGH_DETAIL_RADIUS block around the player is loaded -
// these are the most expensive debug content. No IndexedDB cache (unlike buildings.js).

import * as CANNON from 'cannon-es';
import { tileX2lon, tileY2lat, lon2tileX, lat2tileY } from '../geo.js';
import { fetchVectorTileLayer } from './openFreeMap.js';
import { waitForDecodeSlice, DECODE_CHECK_INTERVAL } from './decodeSlice.js';
import {
  DETAIL_ZOOM,
  HIGH_DETAIL_RADIUS,
  UNLOAD_MARGIN,
  UNLOAD_DELAY_TICKS,
  GROUND_COLLISION_GROUP,
} from '../terrain.js';

const REGION_MARGIN_TILES = 2;
const REGION_RETRY_COOLDOWN_MS = 8000;
const MAX_FEATURES_PER_TILE = 8000;
const BUILD_TIME_CHECK_INTERVAL = 16; // items between performance.now() checks
const GROUND_CHECK_INTERVAL_MS = 500; // how often built chunks look for a changed terrain tile below

export function tileKey(tx, ty) {
  return `${tx}_${ty}`;
}

/** Key of the DETAIL_ZOOM tile containing (lat, lon). */
function inSquare(dx, dy, radius) {
  return Math.abs(dx) <= radius && Math.abs(dy) <= radius;
}

/** Offsets of a (2r+1)^2 square, nearest first. */
function squareOffsets(radius) {
  const offsets = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) offsets.push({ dx, dy });
  }
  return offsets.sort((a, b) => a.dx * a.dx + a.dy * a.dy - (b.dx * b.dx + b.dy * b.dy));
}

function detailTileKeyAt(lat, lon) {
  return tileKey(Math.floor(lon2tileX(lon, DETAIL_ZOOM)), Math.floor(lat2tileY(lat, DETAIL_ZOOM)));
}

export class VectorTileLayer {
  /**
   * @param {object} opts
   * @param {number} opts.tileZoom - zoom the vector tiles are served at.
   * @param {string} opts.layerName - MVT layer to read ('transportation', 'water', ...).
   * @param {(props: object) => ({key: string} | null)} opts.classify - feature props -> style, null skips.
   * @param {boolean} [opts.alwaysStream] - stream data even while hidden (gameplay uses it).
   * @param {number} [opts.radius] - square half-size, in DETAIL_ZOOM tiles, of the loaded block.
   * @param {import('../terrain.js').TerrainManager} [opts.terrain] - ground heights from the rendered
   *   surface (any tile, physics or not); chunks wait for it and rebuild when it changes.
   */
  constructor(
    scene,
    world,
    originLat,
    originLon,
    { tileZoom, layerName, classify, alwaysStream = false, radius = HIGH_DETAIL_RADIUS, terrain = null }
  ) {
    this.scene = scene;
    this.world = world;
    this.originLat = originLat;
    this.originLon = originLon;
    this.scaleLat = originLat; // see geo.js; kept by shiftOrigin()
    this.tileZoom = tileZoom;
    this.layerName = layerName;
    this.classify = classify;
    this.alwaysStream = alwaysStream;
    this.radius = radius;
    this.terrain = terrain;
    this._groundCheckedAt = 0;
    this._loadOffsets = squareOffsets(radius);
    this.tileZoomRatio = 2 ** (DETAIL_ZOOM - tileZoom);

    this.chunks = new Map(); // key -> { meshes, tx, ty }
    this.pendingRemoval = new Map(); // key -> ticks left
    this._visible = false;
    this._buildQueue = []; // [{ tx, ty, key }]
    this._queuedKeys = new Set();
    this._inProgressBuilds = new Map(); // key -> build descriptor paused mid-tile

    this._region = null; // { minTx, maxTx, minTy, maxTy }
    this._itemsByTile = new Map(); // detail tile key -> items
    this._itemsBySourceTile = new Map(); // tileZoom tile key -> items decoded from it
    this._sourceTiles = new Map(); // tileZoom tile key -> decoded { byTile, items }, reused across region moves
    this._regionPending = null;
    this._regionFailedAt = 0;
    this._generation = 0;
  }

  _key(tx, ty) {
    return tileKey(tx, ty);
  }

  _keepRadius() {
    return this.radius + UNLOAD_MARGIN;
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

  /**
   * Items decoded from the tileZoom tile containing (lat, lon). The source
   * clips features to its tile, so this holds every polygon piece covering it.
   */
  _itemsInSourceTile(lat, lon) {
    const key = tileKey(Math.floor(lon2tileX(lon, this.tileZoom)), Math.floor(lat2tileY(lat, this.tileZoom)));
    return this._itemsBySourceTile.get(key) ?? [];
  }

  /** Fetches one vector tile: its items, also bucketed by detail tile key. Decoding is time-sliced if `sliced`. */
  async _fetchTile(tx, ty, sliced) {
    const { tileZoom, layerName } = this;
    const layer = await fetchVectorTileLayer(tileZoom, tx, ty, layerName);
    const byTile = new Map();
    const items = [];
    if (!layer) return { byTile, items };

    const extent = layer.extent;
    const toLatLon = (p) => ({
      lat: tileY2lat(ty + p.y / extent, tileZoom),
      lon: tileX2lon(tx + p.x / extent, tileZoom),
    });
    const add = (lat, lon, item) => {
      const key = detailTileKeyAt(lat, lon);
      let list = byTile.get(key);
      if (!list) byTile.set(key, (list = []));
      list.push(item);
      items.push(item);
    };

    const featureCount = Math.min(layer.length, MAX_FEATURES_PER_TILE);
    for (let i = 0; i < featureCount; i++) {
      if (sliced && i % DECODE_CHECK_INTERVAL === 0) await waitForDecodeSlice();
      try {
        const feature = layer.feature(i);
        const style = this.classify(feature.properties);
        if (!style) continue;
        this._decodeFeature(feature.loadGeometry(), style, toLatLon, add, extent);
      } catch (err) {
        console.warn(`Skipping one malformed ${layerName} feature`, tx, ty, err);
      }
    }
    return { byTile, items };
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
  async _ensureRegion(centerTx, centerTy, sliced) {
    if (this._regionCovers(centerTx, centerTy)) return;
    if (this._regionPending) {
      await this._regionPending.catch(() => {});
      if (this._regionCovers(centerTx, centerTy)) return;
    }
    if (this._regionFailedAt && Date.now() - this._regionFailedAt < REGION_RETRY_COOLDOWN_MS) return;

    const r = this._keepRadius() + REGION_MARGIN_TILES;
    const region = { minTx: centerTx - r, maxTx: centerTx + r, minTy: centerTy - r, maxTy: centerTy + r };
    const promise = this._fetchRegion(region, this._generation, sliced);
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

  async _fetchRegion(region, generation, sliced) {
    const ratio = this.tileZoomRatio;
    const tileCoords = [];
    for (let tx = Math.floor(region.minTx / ratio); tx <= Math.floor(region.maxTx / ratio); tx++) {
      for (let ty = Math.floor(region.minTy / ratio); ty <= Math.floor(region.maxTy / ratio); ty++) {
        tileCoords.push([tx, ty]);
      }
    }

    const cached = this._sourceTiles;
    const results = await Promise.allSettled(
      tileCoords.map(([tx, ty]) => cached.get(tileKey(tx, ty)) ?? this._fetchTile(tx, ty, sliced))
    );
    if (generation !== this._generation) return; // recentered meanwhile

    const sourceTiles = new Map();
    const byTile = new Map();
    const bySourceTile = new Map();
    let failed = 0;
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        failed++;
        return;
      }
      sourceTiles.set(tileKey(...tileCoords[i]), result.value);
      bySourceTile.set(tileKey(...tileCoords[i]), result.value.items);
      for (const [key, list] of result.value.byTile) {
        let existing = byTile.get(key);
        if (!existing) byTile.set(key, (existing = []));
        existing.push(...list);
      }
    });
    if (tileCoords.length > 0 && failed === tileCoords.length) {
      throw new Error(`All ${failed} ${this.layerName} tile request(s) failed`);
    }

    this._region = region;
    this._itemsByTile = byTile;
    this._itemsBySourceTile = bySourceTile;
    this._sourceTiles = sourceTiles;
  }

  /** Ground y at (x, z): the rendered terrain surface, else a ground raycast, else 0. */
  _groundHeightAt(x, z) {
    const y = this.terrain?.surfaceHeightAt(x, z);
    if (y != null) return y;
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

  /** Terrain tile under (tx, ty) and its revision, so a chunk can tell its heights went stale. */
  _groundStamp(tx, ty) {
    const tile = this.terrain?.surfaceTileAt(tx, ty) ?? null;
    return { tile, revision: tile?.surfaceRevision ?? 0 };
  }

  /** Without terrain there's nothing to wait for. */
  _groundReady(tx, ty) {
    return !this.terrain || !!this.terrain.surfaceTileAt(tx, ty);
  }

  _beginChunkBuild(tx, ty) {
    const key = this._key(tx, ty);
    const ground = this._groundStamp(tx, ty);
    return { tx, ty, key, ground, list: this._itemsByTile.get(key) || [], index: 0, byStyleKey: new Map() };
  }

  /** Queues a rebuild of every chunk whose terrain tile was replaced or rebuilt since it was built. */
  _queueStaleChunks() {
    if (!this.terrain) return;
    for (const [key, chunk] of this.chunks) {
      if (this._queuedKeys.has(key) || this._inProgressBuilds.has(key)) continue;
      const { tile, revision } = this._groundStamp(chunk.tx, chunk.ty);
      if (!tile || (tile === chunk.ground.tile && revision === chunk.ground.revision)) continue;
      this._queuedKeys.add(key);
      this._buildQueue.push({ tx: chunk.tx, ty: chunk.ty, key, rebuild: true });
    }
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

  _finishChunkBuild({ tx, ty, key, ground, byStyleKey }) {
    const old = this.chunks.get(key);
    if (old) this._disposeMeshes(old);
    const meshes = [];
    for (const bucket of byStyleKey.values()) {
      const mesh = this._makeMesh(bucket);
      if (!mesh) continue;
      mesh.visible = this._visible;
      this.scene.add(mesh);
      meshes.push(mesh);
    }
    this.chunks.set(key, { meshes, tx, ty, ground });
  }

  /** Pending work for the streaming indicator: a region fetch, and tile mesh builds. */
  pendingWork() {
    return { downloads: this._regionPending ? 1 : 0, builds: this._buildQueue.length + this._inProgressBuilds.size };
  }

  /** True once a tile's meshes are built (not just fetched) - for the debug stats HUD. */
  isTileLoaded(tx, ty) {
    return this.chunks.has(this._key(tx, ty));
  }

  /** True once the fetched region covers (lat, lon), so queries there are final. */
  hasDataAt(lat, lon) {
    const region = this._region;
    if (!region) return false;
    const tx = Math.floor(lon2tileX(lon, DETAIL_ZOOM));
    const ty = Math.floor(lat2tileY(lat, DETAIL_ZOOM));
    return tx >= region.minTx && tx <= region.maxTx && ty >= region.minTy && ty <= region.maxTy;
  }

  _disposeMeshes(chunk) {
    for (const mesh of chunk.meshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
  }

  _unloadChunk(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this._disposeMeshes(chunk);
    this.chunks.delete(key);
    this.pendingRemoval.delete(key);
  }

  /** M-key debug toggle. */
  /** Meshes exist only while shown; hiding drops them (the data keeps streaming if alwaysStream). */
  setVisible(visible) {
    this._visible = visible;
    if (visible) return;
    for (const key of Array.from(this.chunks.keys())) this._unloadChunk(key);
    this.pendingRemoval.clear();
    this._buildQueue = [];
    this._queuedKeys.clear();
    this._inProgressBuilds.clear();
  }

  recenter(lat, lon) {
    for (const key of Array.from(this.chunks.keys())) this._unloadChunk(key);
    this.pendingRemoval.clear();
    this._buildQueue = [];
    this._queuedKeys.clear();
    this._inProgressBuilds.clear();
    this._region = null;
    this._itemsByTile = new Map();
    this._itemsBySourceTile = new Map();
    this._sourceTiles = new Map();
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

  /**
   * Streams data around (centerTx, centerTy) and, while visible, builds meshes
   * until `deadline` (unbounded if `awaitAll`, which also waits for the data).
   */
  async update(centerTx, centerTy, awaitAll = false, deadline = Infinity) {
    if (!this.alwaysStream && !this._visible) return;

    const ensure = this._ensureRegion(centerTx, centerTy, !awaitAll);
    if (awaitAll) await ensure;
    else ensure.catch(() => {});
    if (!this._visible) return;

    const keepRadius = this._keepRadius();

    if (this._regionCovers(centerTx, centerTy)) {
      for (const { dx, dy } of this._loadOffsets) {
        const tx = centerTx + dx;
        const ty = centerTy + dy;
        const key = this._key(tx, ty);
        if (this.chunks.has(key) || this._inProgressBuilds.has(key) || this._queuedKeys.has(key)) continue;
        if (!this._groundReady(tx, ty)) continue;
        this._queuedKeys.add(key);
        this._buildQueue.push({ tx, ty, key });
      }
    }

    const now = performance.now();
    if (now - this._groundCheckedAt >= GROUND_CHECK_INTERVAL_MS) {
      this._groundCheckedAt = now;
      this._queueStaleChunks();
    }

    if (awaitAll) deadline = Infinity;
    // Finish tiles paused mid-build before starting new ones.
    for (const [key, build] of this._inProgressBuilds) {
      if (performance.now() >= deadline) break;
      if (!inSquare(build.tx - centerTx, build.ty - centerTy, keepRadius)) {
        this._inProgressBuilds.delete(key);
        continue;
      }
      if (this._stepChunkBuild(build, deadline)) {
        this._finishChunkBuild(build);
        this._inProgressBuilds.delete(key);
      }
    }
    while (this._buildQueue.length && performance.now() < deadline) {
      const { tx, ty, key, rebuild } = this._buildQueue.shift();
      this._queuedKeys.delete(key);
      if (this.chunks.has(key) && !rebuild) continue;
      if (!inSquare(tx - centerTx, ty - centerTy, keepRadius)) continue;
      const build = this._beginChunkBuild(tx, ty);
      if (this._stepChunkBuild(build, deadline)) {
        this._finishChunkBuild(build);
      } else {
        this._inProgressBuilds.set(key, build);
      }
    }

    for (const [k, chunk] of this.chunks) {
      if (!inSquare(chunk.tx - centerTx, chunk.ty - centerTy, keepRadius)) {
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
