import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { lon2tileX, lat2tileY, localToLatLon, latLonToLocal, tileX2lon, tileY2lat, tileSizeMeters } from './geo.js';
import { loadTileData } from './terrain/tileLoader.js';
import { buildTileGeometry, buildTileDebugLines, geometryFromGridMesh } from './terrain/tileMesh.js';
import { sampleHeight } from './terrain/surfaceGrid.js';
import { roadBedBorderPx } from './terrain/roadBed.js';

// Terrain is one quadtree of Web Mercator tiles around the player: ROOT_ZOOM
// tiles out to FAR_RADIUS_METERS, refined down to DETAIL_ZOOM next to the
// car. A tile splits while the player is within SPLIT_DISTANCE of its own
// width, so on-screen detail stays roughly even with ~100-200 tiles in all.
// The DETAIL_RADIUS circle of DETAIL_ZOOM tiles (which buildings and vector
// overlays align to) is always fully split and gets physics + sharper
// imagery; HIGH is the 3x3 block within it. A tile is only hidden once
// whatever replaces it has loaded, so splits/merges never leave holes.
// DETAIL_ZOOM tiles are built in the worker on a fine grid with OSM roads
// carved in as a raised bed (terrain/detailSurface.js, terrain/roadBed.js).

export const DETAIL_ZOOM = 15; // ~600-800m tiles at mid latitudes
const DETAIL_CELLS = 256; // ~3 m cells across a DETAIL_ZOOM tile (mesh and physics Heightfield), fine enough for road beds
const DETAIL_LINE_STRIDE = 16; // debug grid lines every this many detail cells
const DETAIL_SKIRT_DEPTH = 16; // metres; coarse neighbours still leave big cracks
// Coarser tiles by zoom, finest first: [minZoom, grid]. Far tiles are hazed, so they get fewer vertices.
const COARSE_GRIDS = [
  [13, 16], // ~1.5-3 km tiles
  [11, 8], // ~6-12 km
  [0, 4], // ~25-150 km
];
export const DETAIL_RADIUS = 2; // tiles
export const UNLOAD_MARGIN = 1; // tiles of slack before unloading (other streamers)
export const HIGH_DETAIL_RADIUS = 1; // square, i.e. the 3x3 block
export const DetailLevel = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

/** DetailLevel of a DETAIL_ZOOM tile at (dx, dy) from the player's tile. */
export function detailLevelForOffset(dx, dy) {
  if (Math.abs(dx) <= HIGH_DETAIL_RADIUS && Math.abs(dy) <= HIGH_DETAIL_RADIUS) return DetailLevel.HIGH;
  if (inCircle(dx, dy, DETAIL_RADIUS)) return DetailLevel.MEDIUM;
  return DetailLevel.LOW;
}

// Rounds circle selection out a bit so small radii don't look spiky.
const CIRCLE_SLACK = 0.5;

// Out-of-range chunks of other streamers wait this many update() ticks
// before unloading (absorbs boundary flicker).
export const UNLOAD_DELAY_TICKS = 3;

/** True if (dx, dy) falls within a circle of the given radius, in tile units. */
export function inCircle(dx, dy, radius) {
  const r = radius + CIRCLE_SLACK;
  return dx * dx + dy * dy <= r * r;
}

/** Tile offsets within `radius` (circular), nearest first. */
export function circleOffsets(radius) {
  const ceil = Math.ceil(radius + CIRCLE_SLACK);
  const offsets = [];
  for (let dy = -ceil; dy <= ceil; dy++) {
    for (let dx = -ceil; dx <= ceil; dx++) {
      if (inCircle(dx, dy, radius)) offsets.push({ dx, dy, dist: Math.sqrt(dx * dx + dy * dy) });
    }
  }
  offsets.sort((a, b) => a.dist - b.dist);
  return offsets;
}

const DETAIL_OFFSETS = circleOffsets(DETAIL_RADIUS);
const DETAIL_BOX = Math.max(...DETAIL_OFFSETS.map(({ dx }) => Math.abs(dx))); // square bound of DETAIL_OFFSETS

export const FAR_RADIUS_METERS = 120_000;
const ROOT_ZOOM = 8; // ~100-150 km tiles
const SPLIT_DISTANCE = 1.0; // in the tile's own widths, from the player to the tile's nearest point
// Imagery is fetched at a higher zoom than the mesh and stitched into a mosaic.
const DETAIL_AERIAL_BOOST = 2; // 4x4 child tiles = 1024px texture
const NEAR_AERIAL_BOOST = 1; // 2x2 = 512px, for tiles from NEAR_AERIAL_MIN_ZOOM up
const NEAR_AERIAL_MIN_ZOOM = 13; // coarser tiles are far and hazed: one native 256px tile
const MAX_CONCURRENT_LOADS = 6; // ~the browser's per-host connection limit
const RESELECT_DISTANCE_TILES = 0.25; // player movement (DETAIL_ZOOM tiles) that re-runs selection
const HIDDEN_TILE_LINGER_MS = 8000; // keeps tiles around for back-and-forth driving
const UNLOAD_CHECK_INTERVAL_MS = 500;
const FAILED_RETRY_MS = 10_000;
const SKIRT_DEPTH_CELLS = 0.3; // skirt depth in the tile's grid cells (+2 m)
const STATS_GRID_RADIUS = 6; // debug HUD grid, in DETAIL_ZOOM tiles

// Terrain-only collision group, for ground raycasts that ignore vehicles.
export const GROUND_COLLISION_GROUP = 2;
export const GROUND_MATERIAL = new CANNON.Material('ground');

const _groundRayFrom = new CANNON.Vec3();
const _groundRayTo = new CANNON.Vec3();
const _groundRayResult = new CANNON.RaycastResult();
// Covers Earth's full relief (ocean trench to Everest) relative to the origin
// baseline, so a teleport anywhere still finds the ground.
export const GROUND_SEARCH_HEIGHT = 20000;

/** Terrain surface y at (x, z), or null if no physics tile is loaded there. */
export function findGroundY(world, x, z) {
  _groundRayFrom.set(x, GROUND_SEARCH_HEIGHT, z);
  _groundRayTo.set(x, -GROUND_SEARCH_HEIGHT, z);
  _groundRayResult.reset();
  world.raycastClosest(
    _groundRayFrom,
    _groundRayTo,
    { collisionFilterMask: GROUND_COLLISION_GROUP },
    _groundRayResult
  );
  return _groundRayResult.hasHit ? _groundRayResult.hitPointWorld.y : null;
}

// Sky colour; lives here because sceneSetup.js already imports this module.
export const SKY_COLOR = new THREE.Color(0x87ceeb);

// Terrain skips scene.fog and uses this aerial-perspective haze instead:
// exponential with distance, fading out with altitude so peaks poke through,
// and complete by FAR_RADIUS_METERS so the square edge of the tiles vanishes.
const HAZE_DISTANCE_METERS = 40_000; // e-folding distance
const HAZE_EDGE_START_METERS = FAR_RADIUS_METERS * 0.8;
const HAZE_MAX_HEIGHT_METERS = 10_000; // world y (relative to the fixed origin baseline)
const HAZE_COLOR = SKY_COLOR.clone().multiplyScalar(0.99);

/** onBeforeCompile hook adding the ground haze (one shared program for every tile). */
function applyGroundHaze(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vHazeWorldY;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHazeWorldY = (modelMatrix * vec4(transformed, 1.0)).y;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vHazeWorldY;')
    .replace(
      '#include <opaque_fragment>',
      `
      float hazeDist = length(vViewPosition);
      float hazeHeight = 1.0 - smoothstep(${(HAZE_MAX_HEIGHT_METERS - 500).toFixed(1)}, ${HAZE_MAX_HEIGHT_METERS.toFixed(1)}, vHazeWorldY);
      float groundHaze = max(
        (1.0 - exp(-hazeDist / ${HAZE_DISTANCE_METERS.toFixed(1)})) * hazeHeight,
        smoothstep(${HAZE_EDGE_START_METERS.toFixed(1)}, ${FAR_RADIUS_METERS.toFixed(1)}, hazeDist)
      );
      outgoingLight = mix(outgoingLight, vec3(${HAZE_COLOR.r.toFixed(3)}, ${HAZE_COLOR.g.toFixed(3)}, ${HAZE_COLOR.b.toFixed(3)}), groundHaze);
      #include <opaque_fragment>`
    );
}

function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

/**
 * Streams the terrain quadtree around the player (see the overview at the
 * top). Loads run in a worker, up to MAX_CONCURRENT_LOADS at once, best
 * priority first. Physics tiles get a Heightfield on the same nodes as the
 * render mesh (same diagonals too), so collision matches visuals. `baseline` is where world y=0
 * is sampled (defaults to the origin).
 */
export class TerrainManager {
  constructor(scene, world, originLat, originLon, baseline = { lat: originLat, lon: originLon }) {
    this.scene = scene;
    this.world = world;
    this.originLat = originLat;
    this.originLon = originLon;
    this.scaleLat = originLat; // see geo.js; kept by shiftOrigin()
    this._baseline = baseline;
    this.heightOffset = 0; // subtracted from raw elevation so origin sits near y=0
    this._heightBaselineSet = false; // see init()
    this.bordersVisible = true;

    this.tiles = new Map(); // key -> { key, z, x, y, mesh, surface, body, lines, aerialBoost, texBytes, meshBytes, hiddenSince }
    this._loadedBelow = new Map(); // key -> number of loaded tiles strictly inside it
    this.loading = new Map(); // key -> job in flight
    this._failedAt = new Map(); // key -> time of the last failed load
    this._leaves = []; // desired leaves: [{ z, x, y, key, distMeters, dirX, dirY, detail, covered }]
    this._leafKeys = new Set();
    this._visible = new Set();
    this._detailWaiters = [];
    // Bumped by recenter() so in-flight loads for the old origin bail out.
    this._loadEpoch = 0;

    this._lat = originLat;
    this._lon = originLon;
    this._lastSelect = null; // DETAIL_ZOOM fractional tile coords of the last selection
    this._centerX = 0;
    this._centerY = 0;
    // Player heading (local XZ) for load priority; 0 = no bias.
    this._headingX = 0;
    this._headingZ = 0;
    this._lastUnloadCheck = 0;
    this.stats = { detail: { created: 0, removed: 0 }, coarse: { created: 0, removed: 0 } };
  }

  /**
   * Samples the height baseline once, at the app's fixed shared origin, so
   * world y means the same real elevation for every client (recenter()
   * must not re-baseline). Falls back to 0 on fetch failure. Then loads the
   * initial physics footprint.
   */
  async init() {
    if (!this._heightBaselineSet) {
      const fx = lon2tileX(this._baseline.lon, DETAIL_ZOOM);
      const fy = lat2tileY(this._baseline.lat, DETAIL_ZOOM);
      const tx = Math.floor(fx);
      const ty = Math.floor(fy);
      const { elev } = await loadTileData({ z: DETAIL_ZOOM, x: tx, y: ty });
      if (elev?.heights) {
        this.heightOffset = sampleHeight(elev, fx - tx, fy - ty);
      } else {
        console.warn('Origin elevation fetch failed, defaulting height baseline to 0', elev?.error);
        this.heightOffset = 0;
      }
      this._heightBaselineSet = true;
    }
    await this.update(0, 0, true);
  }

  /** True once a DETAIL_ZOOM tile's mesh is built - for the debug stats HUD. */
  isTileLoaded(tx, ty) {
    return this.tiles.has(tileKey(DETAIL_ZOOM, tx, ty));
  }

  /**
   * Teleport support: tears everything down and streams a fresh set around
   * a new lat/lon origin (the flat local projection is only accurate near
   * its origin). Resolves once the physics footprint is loaded.
   */
  async recenter(lat, lon) {
    this._loadEpoch++; // invalidate in-flight loads first
    for (const tile of Array.from(this.tiles.values())) this._disposeTile(tile);
    this.loading.clear();
    this._failedAt.clear();
    this._leaves = [];
    this._leafKeys.clear();
    this._visible = new Set();
    this._lastSelect = null;
    // Resolve outstanding waiters so an awaitAll update() never hangs.
    const waiters = this._detailWaiters;
    this._detailWaiters = [];
    waiters.forEach((resolve) => resolve());

    this.originLat = lat;
    this.originLon = lon;
    this.scaleLat = lat;
    await this.init();
  }

  /**
   * Floating-origin shift: the caller has already translated every scene
   * object and physics body; only the projection origin moves here.
   */
  shiftOrigin(lat, lon) {
    this.originLat = lat;
    this.originLon = lon;
  }

  _isPhysicsTile(z, x, y) {
    return z === DETAIL_ZOOM && inCircle(x - this._centerX, y - this._centerY, DETAIL_RADIUS);
  }

  /** Rebuilds the desired leaf set for the current player position. */
  _select() {
    const lat = this._lat;
    const lon = this._lon;
    const px = [];
    const py = [];
    const sizeMeters = [];
    for (let z = ROOT_ZOOM; z <= DETAIL_ZOOM; z++) {
      px[z] = lon2tileX(lon, z);
      py[z] = lat2tileY(lat, z);
      sizeMeters[z] = tileSizeMeters(z, lat);
    }
    const cx = this._centerX;
    const cy = this._centerY;

    const leaves = [];
    const visit = (z, x, y) => {
      const n = 2 ** z;
      if (x < 0 || y < 0 || x >= n || y >= n) return;
      // Distance (in this tile's widths) from the player to the tile's nearest point.
      const dx = Math.max(x - px[z], 0, px[z] - (x + 1));
      const dy = Math.max(y - py[z], 0, py[z] - (y + 1));
      const dist = Math.hypot(dx, dy);
      if (dist * sizeMeters[z] > FAR_RADIUS_METERS) return;
      if (z < DETAIL_ZOOM) {
        const s = 2 ** (DETAIL_ZOOM - z);
        const coversPhysics =
          x * s <= cx + DETAIL_BOX && (x + 1) * s > cx - DETAIL_BOX && y * s <= cy + DETAIL_BOX && (y + 1) * s > cy - DETAIL_BOX;
        if (dist < SPLIT_DISTANCE || coversPhysics) {
          visit(z + 1, 2 * x, 2 * y);
          visit(z + 1, 2 * x + 1, 2 * y);
          visit(z + 1, 2 * x, 2 * y + 1);
          visit(z + 1, 2 * x + 1, 2 * y + 1);
          return;
        }
      }
      leaves.push({
        z,
        x,
        y,
        key: tileKey(z, x, y),
        distMeters: dist * sizeMeters[z],
        dirX: x + 0.5 - px[z],
        dirY: y + 0.5 - py[z],
        detail: this._isPhysicsTile(z, x, y),
        covered: false,
      });
    };

    const r = FAR_RADIUS_METERS / sizeMeters[ROOT_ZOOM];
    for (let y = Math.floor(py[ROOT_ZOOM] - r); y <= Math.floor(py[ROOT_ZOOM] + r); y++) {
      for (let x = Math.floor(px[ROOT_ZOOM] - r); x <= Math.floor(px[ROOT_ZOOM] + r); x++) {
        visit(ROOT_ZOOM, x, y);
      }
    }
    this._leaves = leaves;
    this._leafKeys = new Set(leaves.map((leaf) => leaf.key));
  }

  /** Loaded tiles that fully cover (z, x, y), pushed to `out`; false if there's a gap. */
  _collectCover(z, x, y, out) {
    const key = tileKey(z, x, y);
    if (this.tiles.has(key)) {
      out.push(key);
      return true;
    }
    if (z >= DETAIL_ZOOM || !this._loadedBelow.get(key)) return false;
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        if (!this._collectCover(z + 1, 2 * x + i, 2 * y + j, out)) return false;
      }
    }
    return true;
  }

  _loadedAncestor(z, x, y) {
    for (let zz = z - 1, xx = x >> 1, yy = y >> 1; zz >= ROOT_ZOOM; zz--, xx >>= 1, yy >>= 1) {
      const key = tileKey(zz, xx, yy);
      if (this.tiles.has(key)) return key;
    }
    return null;
  }

  _hasVisibleAncestor(tile, visible) {
    return this._ancestorKeys(tile).some((key) => visible.has(key));
  }

  _ancestorKeys({ z, x, y }) {
    const keys = [];
    for (let zz = z - 1, xx = x >> 1, yy = y >> 1; zz >= ROOT_ZOOM; zz--, xx >>= 1, yy >>= 1) {
      keys.push(tileKey(zz, xx, yy));
    }
    return keys;
  }

  /**
   * Picks what to draw: each desired leaf if loaded, else loaded finer tiles
   * that fully cover it, else its nearest loaded ancestor. Then syncs mesh
   * visibility, debug lines and physics bodies.
   */
  _updateDisplay() {
    const visible = new Set();
    for (const leaf of this._leaves) {
      leaf.covered = true;
      if (this.tiles.has(leaf.key)) {
        visible.add(leaf.key);
        continue;
      }
      const cover = [];
      if (this._collectCover(leaf.z, leaf.x, leaf.y, cover)) {
        cover.forEach((key) => visible.add(key));
        continue;
      }
      const ancestor = this._loadedAncestor(leaf.z, leaf.x, leaf.y);
      if (ancestor) visible.add(ancestor);
      else leaf.covered = false;
    }
    // A shown ancestor (standing in for a leaf still loading) hides its descendants.
    for (const key of visible) {
      if (this._hasVisibleAncestor(this.tiles.get(key), visible)) visible.delete(key);
    }

    const now = performance.now();
    for (const tile of this.tiles.values()) {
      const show = visible.has(tile.key);
      tile.mesh.visible = show;
      if (show) tile.hiddenSince = null;
      else if (tile.hiddenSince == null) tile.hiddenSince = now;
      this._syncDebugLines(tile);
      this._syncBody(tile);
    }
    this._visible = visible;
  }

  _syncDebugLines(tile) {
    const want = this.bordersVisible && tile.mesh.visible;
    if (want && !tile.lines) {
      tile.lines = buildTileDebugLines(tile.surface, 2 ** (DETAIL_ZOOM - tile.z));
      tile.lines.border.position.copy(tile.mesh.position);
      tile.lines.grid.position.copy(tile.mesh.position);
      this.scene.add(tile.lines.border, tile.lines.grid);
    }
    if (tile.lines) {
      tile.lines.border.visible = want;
      tile.lines.grid.visible = want;
    }
  }

  /** Physics only on the DETAIL_RADIUS circle (kept even while an ancestor is drawn in its place). */
  _syncBody(tile) {
    const want = this._isPhysicsTile(tile.z, tile.x, tile.y) && !!tile.heightfield;
    if (want && !tile.body) {
      // Heightfield is data[x][y] with local y pointing north once rotated
      // upright, so it's anchored at the south-west node.
      const { heights, cols, rows, elementSize } = tile.heightfield;
      const data = [];
      for (let c = 0; c < cols; c++) {
        const column = new Array(rows);
        for (let k = 0; k < rows; k++) column[k] = heights[(rows - 1 - k) * cols + c];
        data.push(column);
      }
      const shape = new CANNON.Heightfield(data, { elementSize });
      shape.collisionFilterGroup = GROUND_COLLISION_GROUP;
      const body = new CANNON.Body({ mass: 0, material: GROUND_MATERIAL });
      body.position.set(tile.mesh.position.x, 0, tile.mesh.position.z + (rows - 1) * elementSize);
      body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
      body.collisionFilterGroup = GROUND_COLLISION_GROUP;
      body.addShape(shape);
      this.world.addBody(body);
      tile.body = body;
    } else if (!want && tile.body) {
      this.world.removeBody(tile.body);
      tile.body = null;
    }
  }

  /**
   * Lower = sooner: HIGH, then MEDIUM physics tiles, then their imagery
   * upgrades, then holes (coarse first, so the view fills fast), then
   * refinements by distance with tiles behind the player counted farther.
   */
  _jobScore(leaf, kind) {
    if (leaf.detail) {
      if (kind === 'texture') return 2e9 + leaf.distMeters;
      const level = detailLevelForOffset(leaf.x - this._centerX, leaf.y - this._centerY);
      return (level === DetailLevel.HIGH ? 0 : 1e9) + leaf.distMeters;
    }
    if (!leaf.covered) return 3e9 + leaf.z * 1e7 + leaf.distMeters;
    const dirLen = Math.hypot(leaf.dirX, leaf.dirY);
    const headingLen = Math.hypot(this._headingX, this._headingZ);
    const cos =
      dirLen && headingLen ? (leaf.dirX * this._headingX + leaf.dirY * this._headingZ) / (dirLen * headingLen) : 0;
    return 4e9 + leaf.distMeters * (1 + 0.5 * (1 - cos));
  }

  _nextJob() {
    const now = performance.now();
    let best = null;
    let bestScore = Infinity;
    for (const leaf of this._leaves) {
      if (this.loading.has(leaf.key)) continue;
      const tile = this.tiles.get(leaf.key);
      let kind;
      if (!tile) {
        const failedAt = this._failedAt.get(leaf.key);
        if (failedAt != null && now - failedAt < FAILED_RETRY_MS) continue;
        kind = 'tile';
      } else if (leaf.detail && tile.aerialBoost < DETAIL_AERIAL_BOOST) {
        kind = 'texture';
      } else {
        continue;
      }
      const score = this._jobScore(leaf, kind);
      if (score < bestScore) {
        bestScore = score;
        best = { ...leaf, kind };
      }
    }
    return best;
  }

  _pump() {
    while (this.loading.size < MAX_CONCURRENT_LOADS) {
      const job = this._nextJob();
      if (!job) return;
      this._runJob(job);
    }
  }

  async _runJob(job) {
    const { z, x, y, key } = job;
    const epoch = this._loadEpoch;
    this.loading.set(key, job);
    try {
      if (job.kind === 'texture') {
        const { bitmap } = await loadTileData({ z, x, y, elevation: false, aerialBoost: DETAIL_AERIAL_BOOST });
        const tile = this.tiles.get(key);
        if (epoch !== this._loadEpoch || !tile || !bitmap) {
          bitmap?.close();
          return;
        }
        this._setTileTexture(tile, bitmap, DETAIL_AERIAL_BOOST);
        return;
      }

      const aerialBoost = job.detail ? DETAIL_AERIAL_BOOST : z >= NEAR_AERIAL_MIN_ZOOM ? NEAR_AERIAL_BOOST : 0;
      const detail = z === DETAIL_ZOOM ? this._detailParams(x, y) : null;
      const elevationBorder = detail ? roadBedBorderPx(tileSizeMeters(z, tileY2lat(y + 0.5, z)) / 256) : 0;
      const { elev, bitmap, surface } = await loadTileData({ z, x, y, elevationBorder, aerialBoost, detail });
      if (epoch !== this._loadEpoch || this.tiles.has(key)) {
        bitmap?.close();
        return;
      }
      const heights = detail ? (surface && elev?.ok ? surface : null) : elev?.heights ? elev : null;
      if (detail && !surface) {
        console.warn('Terrain detail surface failed', z, x, y, elev?.error);
        this._failedAt.set(key, performance.now());
        bitmap?.close();
        return;
      }
      if (!heights) {
        // Physics tiles fall back to flat (safer than a hole to fall
        // through); others retry later while an ancestor stands in.
        console.warn('Terrain elevation fetch failed', z, x, y, elev?.error);
        if (!job.detail) {
          this._failedAt.set(key, performance.now());
          bitmap?.close();
          return;
        }
      }
      if (detail) this._addDetailTile(job, surface, bitmap, aerialBoost);
      else this._addTile(job, heights, bitmap, aerialBoost);
    } catch (err) {
      console.warn('Terrain tile failed to load', z, x, y, err);
    } finally {
      if (this.loading.get(key) === job) this.loading.delete(key);
      if (epoch === this._loadEpoch) {
        this._updateDisplay();
        this._resolveDetailWaiters();
        this._pump();
      }
    }
  }

  /** Worker parameters for a DETAIL_ZOOM tile's surface: its size in the local frame. */
  _detailParams(x, y) {
    const z = DETAIL_ZOOM;
    const nw = latLonToLocal(tileY2lat(y, z), tileX2lon(x, z), this.originLat, this.originLon, this.scaleLat);
    const se = latLonToLocal(tileY2lat(y + 1, z), tileX2lon(x + 1, z), this.originLat, this.originLon, this.scaleLat);
    return {
      widthMeters: se.x - nw.x,
      heightMeters: se.z - nw.z,
      cells: DETAIL_CELLS,
      heightOffset: this.heightOffset,
      skirtDepth: DETAIL_SKIRT_DEPTH,
    };
  }

  /** Detail tile from the worker's surface: positions are relative to the NW corner. */
  _addDetailTile({ z, x, y, key }, { mesh: gridMesh, cols, rows, heightfield }, bitmap, aerialBoost) {
    const { geometry, surface } = geometryFromGridMesh(gridMesh, cols, rows, { lineStride: DETAIL_LINE_STRIDE, nwse: true });
    const nw = latLonToLocal(tileY2lat(y, z), tileX2lon(x, z), this.originLat, this.originLon, this.scaleLat);
    const tile = this._createTileMesh({ z, x, y, key }, geometry, surface, { x: nw.x, y: 0, z: nw.z }, bitmap, aerialBoost);
    tile.heightfield = heightfield;
  }

  _addTile({ z, x, y, key }, elev, bitmap, aerialBoost) {
    const grid = COARSE_GRIDS.find(([minZoom]) => z >= minZoom)[1];
    const cellMeters = tileSizeMeters(z, this.originLat) / grid;
    const { geometry, anchor, surface } = buildTileGeometry({
      z,
      x,
      y,
      grid,
      elev,
      heightOffset: this.heightOffset,
      originLat: this.originLat,
      originLon: this.originLon,
      scaleLat: this.scaleLat,
      skirtDepth: cellMeters * SKIRT_DEPTH_CELLS + 2,
    });
    this._createTileMesh({ z, x, y, key }, geometry, surface, anchor, bitmap, aerialBoost);
  }

  _createTileMesh({ z, x, y, key }, geometry, surface, anchor, bitmap, aerialBoost) {
    const material = new THREE.MeshStandardMaterial({ roughness: 1, fog: false });
    material.onBeforeCompile = applyGroundHaze;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = z === DETAIL_ZOOM; // the shadow frustum only spans metres around the car
    mesh.position.set(anchor.x, anchor.y, anchor.z);
    mesh.matrixAutoUpdate = false; // never moves
    mesh.updateMatrix();
    mesh.visible = false; // _updateDisplay decides
    this.scene.add(mesh);

    let meshBytes = 0;
    for (const attr of Object.values(geometry.attributes)) meshBytes += attr.array.byteLength;
    meshBytes += geometry.index.array.byteLength;

    const tile = {
      key,
      z,
      x,
      y,
      mesh,
      surface,
      heightfield: null, // DETAIL_ZOOM only
      body: null,
      lines: null,
      aerialBoost: 0,
      texBytes: 0,
      meshBytes,
      hiddenSince: performance.now(),
    };
    this._setTileTexture(tile, bitmap, aerialBoost);
    this.tiles.set(key, tile);
    for (const k of this._ancestorKeys(tile)) this._loadedBelow.set(k, (this._loadedBelow.get(k) || 0) + 1);
    this._failedAt.delete(key);
    this.stats[z === DETAIL_ZOOM ? 'detail' : 'coarse'].created++;
    return tile;
  }

  /** Swaps in a texture from `bitmap` (none: untextured); the bitmap is freed once on the GPU. */
  _setTileTexture(tile, bitmap, aerialBoost) {
    const material = tile.mesh.material;
    const old = material.map;
    if (bitmap) {
      const tex = new THREE.Texture(bitmap);
      tex.flipY = false; // ignored for ImageBitmap anyway; UVs account for it
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.onUpdate = () => bitmap.close();
      tex.needsUpdate = true;
      material.map = tex;
      tile.texBytes = Math.round(bitmap.width * bitmap.height * 4 * (4 / 3)); // + mipmaps
      if (!old) material.needsUpdate = true;
    }
    if (old && old !== material.map) {
      old.image?.close?.();
      old.dispose();
    }
    tile.aerialBoost = aerialBoost;
  }

  _disposeTile(tile) {
    this.scene.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    const map = tile.mesh.material.map;
    if (map) {
      map.image?.close?.(); // if never uploaded
      map.dispose();
    }
    tile.mesh.material.dispose();
    if (tile.lines) {
      this.scene.remove(tile.lines.border, tile.lines.grid);
      tile.lines.border.geometry.dispose();
      tile.lines.grid.geometry.dispose();
    }
    if (tile.body) this.world.removeBody(tile.body);
    this.tiles.delete(tile.key);
    for (const k of this._ancestorKeys(tile)) {
      const count = (this._loadedBelow.get(k) || 0) - 1;
      if (count > 0) this._loadedBelow.set(k, count);
      else this._loadedBelow.delete(k);
    }
    this.stats[tile.z === DETAIL_ZOOM ? 'detail' : 'coarse'].removed++;
  }

  /** Drops tiles that are neither drawn nor wanted, after HIDDEN_TILE_LINGER_MS. */
  _unloadStale(now) {
    for (const tile of Array.from(this.tiles.values())) {
      if (tile.hiddenSince == null || this._leafKeys.has(tile.key)) continue;
      if (now - tile.hiddenSince > HIDDEN_TILE_LINGER_MS) this._disposeTile(tile);
    }
  }

  _allPhysicsLoaded() {
    for (const { dx, dy } of DETAIL_OFFSETS) {
      if (!this.tiles.get(tileKey(DETAIL_ZOOM, this._centerX + dx, this._centerY + dy))?.body) return false;
    }
    return true;
  }

  _resolveDetailWaiters() {
    if (!this._detailWaiters.length || !this._allPhysicsLoaded()) return;
    const waiters = this._detailWaiters;
    this._detailWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /** Toggles debug tile lines on current and future tiles. */
  setBordersVisible(visible) {
    this.bordersVisible = visible;
    for (const tile of this.tiles.values()) this._syncDebugLines(tile);
  }

  /**
   * Streams the quadtree around (localX, localZ); cheap when the player
   * hasn't moved much. awaitAll blocks until the physics footprint is
   * loaded. `heading` {x, z} (unnormalized) prioritizes tiles ahead.
   */
  async update(localX, localZ, awaitAll = false, heading = null) {
    if (heading) {
      this._headingX = heading.x;
      this._headingZ = heading.z;
    }
    const { lat, lon } = localToLatLon(localX, localZ, this.originLat, this.originLon, this.scaleLat);
    this._lat = lat;
    this._lon = lon;
    const fx = lon2tileX(lon, DETAIL_ZOOM);
    const fy = lat2tileY(lat, DETAIL_ZOOM);
    const cx = Math.floor(fx);
    const cy = Math.floor(fy);
    const moved =
      !this._lastSelect ||
      cx !== this._centerX ||
      cy !== this._centerY ||
      Math.hypot(fx - this._lastSelect.fx, fy - this._lastSelect.fy) > RESELECT_DISTANCE_TILES;
    if (moved || awaitAll) {
      this._centerX = cx;
      this._centerY = cy;
      this._lastSelect = { fx, fy };
      this._select();
      this._updateDisplay();
      this._pump();
    }

    const now = performance.now();
    if (now - this._lastUnloadCheck > UNLOAD_CHECK_INTERVAL_MS) {
      this._lastUnloadCheck = now;
      this._unloadStale(now);
    }

    if (awaitAll && !this._allPhysicsLoaded()) {
      await new Promise((resolve) => this._detailWaiters.push(resolve));
    }
  }

  /**
   * Debug HUD snapshot: DETAIL_ZOOM tiles ("detail") and coarser ones
   * ("far"), plus a grid of DETAIL_ZOOM cells around the player.
   */
  getStats() {
    const buckets = {
      detail: { loaded: 0, pending: 0, pendingRemoval: 0, memoryBytes: 0 },
      far: { loaded: 0, pending: 0, pendingRemoval: 0, memoryBytes: 0 },
    };
    for (const tile of this.tiles.values()) {
      const b = tile.z === DETAIL_ZOOM ? buckets.detail : buckets.far;
      b.loaded++;
      if (!this._visible.has(tile.key)) b.pendingRemoval++;
      b.memoryBytes += tile.texBytes + tile.meshBytes;
      if (tile.body) b.memoryBytes += tile.heightfield.heights.length * 8; // JS number arrays
    }
    for (const leaf of this._leaves) {
      if (!this.tiles.has(leaf.key)) (leaf.z === DETAIL_ZOOM ? buckets.detail : buckets.far).pending++;
    }

    const grid = [];
    for (let dy = -STATS_GRID_RADIUS; dy <= STATS_GRID_RADIUS; dy++) {
      const row = [];
      for (let dx = -STATS_GRID_RADIUS; dx <= STATS_GRID_RADIUS; dx++) {
        const tx = this._centerX + dx;
        const ty = this._centerY + dy;
        const key = tileKey(DETAIL_ZOOM, tx, ty);
        let state = 'empty';
        if (this._visible.has(key)) state = 'loaded';
        else if (this._leafKeys.has(key)) state = 'pending';
        else if (this.tiles.has(key)) state = 'removing';
        row.push({ tx, ty, state: dx === 0 && dy === 0 ? 'player' : state, level: detailLevelForOffset(dx, dy) });
      }
      grid.push(row);
    }

    return {
      ...buckets.detail,
      created: this.stats.detail.created,
      removed: this.stats.detail.removed,
      center: { tx: this._centerX, ty: this._centerY },
      radius: STATS_GRID_RADIUS,
      gridCenter: { row: STATS_GRID_RADIUS, col: STATS_GRID_RADIUS },
      grid,
      stray: 0,
      far: { ...buckets.far, created: this.stats.coarse.created, removed: this.stats.coarse.removed },
    };
  }
}
