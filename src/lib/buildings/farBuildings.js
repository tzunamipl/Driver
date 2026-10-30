// Far buildings: every footprint out to the far radius as one box (its
// minimum-area rectangle x height), instanced per z14 tile, no physics. A
// box hides in the shader once buildings.js has built the detail tile
// holding it, so near and far never draw the same building twice.

import * as THREE from 'three';
import { tileSizeMeters, tileX2lon, tileY2lat, latLonToLocal } from '../geo.js';
import { DETAIL_ZOOM, DETAIL_BOX, UNLOAD_MARGIN } from '../terrain.js';
import { BUILDING_TILE_ZOOM, MAX_FOOTPRINT_METERS, fetchBuildingFeatures, convexHull2D } from './features.js';

const DEFAULT_FAR_RADIUS_METERS = 1500;
const UNLOAD_EXTRA_METERS = 500; // hysteresis before a tile is dropped
const MAX_CONCURRENT_FETCHES = 2;
const RETRY_COOLDOWN_MS = 8000;
const GROUND_BUDGET_MS = 1; // per frame (within the caller's deadline), re-sampling ground as finer terrain streams in
const TIME_CHECK_INTERVAL = 64; // instances between clock checks
// Boxes reach this far below the centre ground (plus a share of the half
// diagonal for slopes): far terrain changes LOD under them.
const SINK_METERS = 2;
const SINK_PER_METER = 0.3;
const MIN_SIDE_METERS = 1;

const ZOOM_RATIO = 2 ** (DETAIL_ZOOM - BUILDING_TILE_ZOOM);
const NEAR_RADIUS = DETAIL_BOX + UNLOAD_MARGIN; // square buildings.js keeps chunks in
const NEAR_SIZE = 2 * NEAR_RADIUS + 1;

const BOX_GEOMETRY = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0); // y 0..1
const _color = new THREE.Color();

/** Minimum-area rectangle of a footprint (rotating calipers on its hull), or null. */
function footprintBox(points) {
  const hull = convexHull2D(points);
  if (hull.length < 3) return null;
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (!(len > 0)) continue;
    const ux = (b.x - a.x) / len;
    const uz = (b.z - a.z) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * ux + p.z * uz;
      const v = p.z * ux - p.x * uz;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, ux, uz, minU, maxU, minV, maxV };
  }
  if (!best) return null;
  const { ux, uz } = best;
  const cu = (best.minU + best.maxU) / 2;
  const cv = (best.minV + best.maxV) / 2;
  return { x: cu * ux - cv * uz, z: cu * uz + cv * ux, ux, uz, width: best.maxU - best.minU, depth: best.maxV - best.minV };
}

function createFarMaterial(uniforms) {
  const material = new THREE.MeshLambertMaterial();
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aDetailTile;
uniform vec2 uNearCenter;
uniform float uNearMask[${NEAR_SIZE * NEAR_SIZE}];
uniform vec2 uFarCenter;
uniform float uFarRadius;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  vec2 nearOffset = aDetailTile - uNearCenter;
  bool hidden = false;
  if (abs(nearOffset.x) <= ${NEAR_RADIUS}.0 && abs(nearOffset.y) <= ${NEAR_RADIUS}.0) {
    ivec2 cell = ivec2(floor(nearOffset + ${NEAR_RADIUS}.5));
    hidden = uNearMask[cell.y * ${NEAR_SIZE} + cell.x] > 0.5;
  }
  vec2 farOffset = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz - uFarCenter;
  // Collapsed to a point: every triangle degenerates and nothing is drawn.
  if (hidden || dot(farOffset, farOffset) > uFarRadius * uFarRadius) transformed = vec3(0.0);
}`
      );
  };
  return material;
}

/** Streams z14 tiles of instanced building boxes around the player. */
export class FarBuildingsManager {
  constructor(scene, terrain, originLat, originLon) {
    this.scene = scene;
    this.terrain = terrain;
    this.originLat = originLat;
    this.originLon = originLon;
    this.scaleLat = originLat; // see geo.js; kept by shiftOrigin()
    this.radius = DEFAULT_FAR_RADIUS_METERS; // graphics detail, see setRadius
    this.tiles = new Map(); // "tx_ty" (z14) -> { tx, ty, key, state, features, index, mesh, count, sinks, dist }
    this._failedAt = new Map(); // key -> time of the last failed fetch
    this._fetching = 0;
    this._generation = 0; // bumped on recenter() to discard stale fetches
    this._groundKey = null; // ground refresh cursor
    this._groundIndex = 0;
    this._uniforms = {
      uNearCenter: { value: new THREE.Vector2() },
      uNearMask: { value: new Float32Array(NEAR_SIZE * NEAR_SIZE) },
      uFarCenter: { value: new THREE.Vector2() },
      uFarRadius: { value: this.radius },
    };
    this.material = createFarMaterial(this._uniforms);
  }

  /**
   * Per frame with the player's DETAIL_ZOOM tile and the near layer's built
   * chunks ("tx_ty" keys): selects, fetches, and grounds and builds tiles until `deadline`.
   */
  update(centerTx, centerTy, nearChunks, deadline) {
    const lat = tileY2lat(centerTy + 0.5, DETAIL_ZOOM);
    const lon = tileX2lon(centerTx + 0.5, DETAIL_ZOOM);
    const center = latLonToLocal(lat, lon, this.originLat, this.originLon, this.scaleLat);
    this._uniforms.uFarCenter.value.set(center.x, center.z);
    this._updateNearMask(centerTx, centerTy, nearChunks);

    this._select((centerTx + 0.5) / ZOOM_RATIO, (centerTy + 0.5) / ZOOM_RATIO, tileSizeMeters(BUILDING_TILE_ZOOM, lat));
    this._fetchNext();
    // Grounding first: a floating box looks worse than a late one.
    this._refreshGround(Math.min(deadline, performance.now() + GROUND_BUDGET_MS));
    this._buildNext(deadline);
  }

  _updateNearMask(centerTx, centerTy, nearChunks) {
    this._uniforms.uNearCenter.value.set(centerTx, centerTy);
    const mask = this._uniforms.uNearMask.value;
    for (let dy = -NEAR_RADIUS; dy <= NEAR_RADIUS; dy++) {
      for (let dx = -NEAR_RADIUS; dx <= NEAR_RADIUS; dx++) {
        const built = nearChunks.has(`${centerTx + dx}_${centerTy + dy}`);
        mask[(dy + NEAR_RADIUS) * NEAR_SIZE + dx + NEAR_RADIUS] = built ? 1 : 0;
      }
    }
  }

  /** Graphics detail: far boxes out to `meters`; tiles past it unload on the next update. */
  setRadius(meters) {
    this.radius = meters;
    this._uniforms.uFarRadius.value = meters;
  }

  /** Adds tiles within the radius, drops ones past it plus the hysteresis; (cfx, cfy) in z14 tiles. */
  _select(cfx, cfy, tileMeters) {
    const distMeters = (tx, ty) => {
      const dx = Math.max(tx - cfx, 0, cfx - (tx + 1));
      const dy = Math.max(ty - cfy, 0, cfy - (ty + 1));
      return Math.hypot(dx, dy) * tileMeters;
    };
    for (const [key, tile] of this.tiles) {
      tile.dist = distMeters(tile.tx, tile.ty);
      if (tile.dist > this.radius + UNLOAD_EXTRA_METERS) this._unload(key);
    }
    const r = Math.ceil(this.radius / tileMeters);
    const now = performance.now();
    for (let ty = Math.floor(cfy) - r; ty <= Math.floor(cfy) + r; ty++) {
      for (let tx = Math.floor(cfx) - r; tx <= Math.floor(cfx) + r; tx++) {
        const key = `${tx}_${ty}`;
        if (this.tiles.has(key)) continue;
        const dist = distMeters(tx, ty);
        if (dist > this.radius) continue;
        const failedAt = this._failedAt.get(key);
        if (failedAt != null && now - failedAt < RETRY_COOLDOWN_MS) continue;
        this.tiles.set(key, { tx, ty, key, state: 'wanted', dist });
      }
    }
  }

  _nearest(state) {
    let best = null;
    for (const tile of this.tiles.values()) {
      if (tile.state === state && (!best || tile.dist < best.dist)) best = tile;
    }
    return best;
  }

  _fetchNext() {
    while (this._fetching < MAX_CONCURRENT_FETCHES) {
      const tile = this._nearest('wanted');
      if (!tile) return;
      tile.state = 'fetching';
      this._fetching++;
      const generation = this._generation;
      fetchBuildingFeatures(tile.tx, tile.ty)
        .then((features) => {
          if (generation !== this._generation || this.tiles.get(tile.key) !== tile) return;
          tile.features = features;
          tile.state = 'queued';
        })
        .catch((err) => {
          console.warn('Far buildings tile failed', tile.tx, tile.ty, err);
          if (generation !== this._generation || this.tiles.get(tile.key) !== tile) return;
          this.tiles.delete(tile.key);
          this._failedAt.set(tile.key, performance.now());
        })
        .finally(() => {
          if (generation === this._generation) this._fetching--;
        });
    }
  }

  /** Builds instances (nearest tile first) until `deadline`; resumes next frame. */
  _buildNext(deadline) {
    while (performance.now() < deadline) {
      const tile = this._nearest('building') ?? this._nearest('queued');
      if (!tile) return;
      if (tile.state === 'queued' && !tile.features.length) {
        tile.state = 'empty';
        tile.features = null;
        continue;
      }
      if (tile.state === 'queued') this._beginTile(tile);
      if (this._stepTile(tile, deadline)) this._finishTile(tile);
    }
  }

  _beginTile(tile) {
    const n = tile.features.length;
    tile.state = 'building';
    tile.index = 0;
    tile.count = 0;
    tile.nwLat = tileY2lat(tile.ty, BUILDING_TILE_ZOOM);
    tile.nwLon = tileX2lon(tile.tx, BUILDING_TILE_ZOOM);
    const geometry = BOX_GEOMETRY.clone();
    geometry.setAttribute('aDetailTile', new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2));
    const mesh = new THREE.InstancedMesh(geometry, this.material, n);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Kept up to date by shiftOrigin() until it joins the scene.
    const nw = latLonToLocal(tile.nwLat, tile.nwLon, this.originLat, this.originLon, this.scaleLat);
    mesh.position.set(nw.x, 0, nw.z);
    tile.mesh = mesh;
    tile.sinks = new Float32Array(n);
  }

  /** True once every feature is processed. */
  _stepTile(tile, deadline) {
    const { features, mesh } = tile;
    const m = mesh.instanceMatrix.array;
    const detailTiles = mesh.geometry.attributes.aDetailTile.array;
    const colors = mesh.instanceColor.array;
    while (tile.index < features.length) {
      if (tile.index % TIME_CHECK_INTERVAL === 0 && performance.now() >= deadline) return false;
      const { ring, height, color, detailTx, detailTy } = features[tile.index++];
      // Relative to the tile's NW corner: independent of the floating origin.
      const box = footprintBox(ring.map((p) => latLonToLocal(p.lat, p.lon, tile.nwLat, tile.nwLon, this.scaleLat)));
      if (!box || box.width > MAX_FOOTPRINT_METERS || box.depth > MAX_FOOTPRINT_METERS) continue;
      const width = Math.max(MIN_SIDE_METERS, box.width);
      const depth = Math.max(MIN_SIDE_METERS, box.depth);
      const sink = SINK_METERS + SINK_PER_METER * Math.hypot(width, depth) * 0.5;
      const ground = this.terrain?.surfaceHeightAt(mesh.position.x + box.x, mesh.position.z + box.z) ?? 0;
      const i = tile.count++;
      // Columns: footprint axis x width, up x (height + sink), its perpendicular x depth, base position.
      m.set([box.ux * width, 0, box.uz * width, 0, 0, height + sink, 0, 0, -box.uz * depth, 0, box.ux * depth, 0, box.x, ground - sink, box.z, 1], i * 16);
      detailTiles[i * 2] = detailTx;
      detailTiles[i * 2 + 1] = detailTy;
      _color.setHex(color);
      colors[i * 3] = _color.r;
      colors[i * 3 + 1] = _color.g;
      colors[i * 3 + 2] = _color.b;
      tile.sinks[i] = sink;
    }
    return true;
  }

  _finishTile(tile) {
    tile.state = 'ready';
    tile.features = null;
    const { mesh } = tile;
    mesh.count = tile.count;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.geometry.attributes.aDetailTile.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.scene.add(mesh);
  }

  /** Re-samples box bases against the current terrain, round-robin over ready tiles. */
  _refreshGround(deadline) {
    if (!this.terrain) return;
    let checked = 0;
    let switches = 0;
    while (performance.now() < deadline) {
      let tile = this.tiles.get(this._groundKey);
      if (tile?.state !== 'ready' || this._groundIndex >= tile.count) {
        if (tile?.state === 'ready') {
          tile.mesh.instanceMatrix.needsUpdate = true;
          tile.mesh.computeBoundingSphere();
        }
        tile = this._nextReadyTile();
        if (!tile || ++switches > this.tiles.size) return; // at most one pass per frame
        this._groundKey = tile.key;
        this._groundIndex = 0;
      }
      const { mesh, sinks } = tile;
      const m = mesh.instanceMatrix.array;
      while (this._groundIndex < tile.count && ++checked % TIME_CHECK_INTERVAL !== 0) {
        const o = this._groundIndex++ * 16;
        const ground = this.terrain.surfaceHeightAt(mesh.position.x + m[o + 12], mesh.position.z + m[o + 14]);
        if (ground != null) m[o + 13] = ground - sinks[o / 16];
      }
    }
  }

  /** The ready tile after the ground cursor's (map order, wrapping). */
  _nextReadyTile() {
    const ready = [...this.tiles.values()].filter((tile) => tile.state === 'ready');
    if (!ready.length) return null;
    const at = ready.findIndex((tile) => tile.key === this._groundKey);
    return ready[(at + 1) % ready.length];
  }

  _unload(key) {
    const tile = this.tiles.get(key);
    this.tiles.delete(key);
    if (!tile?.mesh) return;
    this.scene.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tile.mesh.dispose();
  }

  /** Drops everything for a new origin (teleport). */
  recenter(lat, lon) {
    for (const key of [...this.tiles.keys()]) this._unload(key);
    this._failedAt.clear();
    this._fetching = 0;
    this._generation++;
    this._groundKey = null;
    this.originLat = lat;
    this.originLon = lon;
    this.scaleLat = lat;
  }

  /** Floating-origin shift: meshes in the scene were moved by the caller; ones still building are moved here. */
  shiftOrigin(lat, lon, dx, dz) {
    this.originLat = lat;
    this.originLon = lon;
    for (const tile of this.tiles.values()) {
      if (tile.mesh && !tile.mesh.parent) {
        tile.mesh.position.x -= dx;
        tile.mesh.position.z -= dz;
      }
    }
  }

  /** Streaming indicator: tiles to fetch, and fetched tiles still to build. */
  pendingWork() {
    let downloads = 0;
    let builds = 0;
    for (const { state } of this.tiles.values()) {
      if (state === 'wanted' || state === 'fetching') downloads++;
      else if (state === 'queued' || state === 'building') builds++;
    }
    return { downloads, builds };
  }

  getStats() {
    let instances = 0;
    let pending = 0;
    let memoryBytes = 0;
    for (const tile of this.tiles.values()) {
      if (tile.state === 'ready') {
        instances += tile.count;
        memoryBytes += tile.mesh.instanceMatrix.array.byteLength * 1.5; // + colour, tile ids, sinks
      } else if (tile.state !== 'empty') {
        pending++;
      }
    }
    return { tiles: this.tiles.size - pending, pending, instances, memoryBytes };
  }
}
