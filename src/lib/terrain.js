import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { lon2tileX, lat2tileY, localToLatLon, latLonToLocal, tileX2lon, tileY2lat, tileSizeMeters } from './geo.js';
import { loadTileData } from './terrain/tileLoader.js';
import { AERIAL_MAX_ZOOM, AERIAL_MAX_REQUESTS } from './terrain/tileUrls.js';
import {
  buildTileGeometry,
  buildTileBorder,
  buildTileWireframe,
  buildRoadProfileLines,
  geometryFromGridMesh,
  pickCauseDot,
  causeDotWorldPosition,
  buildRoadBedSources,
  disposeRoadBedSources,
} from './terrain/tileMesh.js';
import { sampleHeight } from './terrain/surfaceGrid.js';
import { roadBedBorderPx } from './terrain/roadBed.js';
import './terrain/heightfieldRayFix.js';

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

export const DETAIL_ZOOM = 17; // how big tiles are
const DETAIL_CELLS = 15; // cells across a DETAIL_ZOOM tile (mesh and physics Heightfield); road beds widen to suit
const DETAIL_SKIRT_DEPTH = 16; // metres; coarse neighbours still leave big cracks
// Coarser tiles by zoom, finest first: [minZoom, grid]. Far tiles are hazed, so they get fewer vertices.
const COARSE_GRIDS = [
  [13, 32], // ~1.5-3 km tiles
  [11, 16], // ~6-12 km
  [0, 8], // ~25-150 km
];
export const DETAIL_RADIUS = 4; // tiles
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
export const DETAIL_BOX = Math.max(...DETAIL_OFFSETS.map(({ dx }) => Math.abs(dx))); // square bound of DETAIL_OFFSETS

export const FAR_RADIUS_METERS = 120_000;
const ROOT_ZOOM = 8; // ~100-150 km tiles
const SPLIT_DISTANCE = 1.0; // in the tile's own widths, from the player to the tile's nearest point
// Imagery is fetched at a higher zoom than the mesh and stitched into a mosaic (capped at AERIAL_MAX_ZOOM).
const AERIAL_BOOST = { [DetailLevel.HIGH]: 2, [DetailLevel.MEDIUM]: 1, [DetailLevel.LOW]: 0 }; // 1024 / 512 / 256px textures
// Detail tiles load geometry without imagery, then step up through MEDIUM to their level.
const NO_IMAGERY = -1;
// The player's own tile gets imagery at AERIAL_MAX_ZOOM once nothing else is queued, then the tiles ahead of
// it; kept within this many tiles.
const PLAYER_TILE_BOOST = AERIAL_MAX_ZOOM - DETAIL_ZOOM;
const PLAYER_TILE_KEEP_RADIUS = 1; // square
const AHEAD_TILE_REACH = 1.5; // DETAIL_ZOOM tiles along the heading from the car that also get the mosaic
const AHEAD_TILE_MAX = 2; // each mosaic is 4^PLAYER_TILE_BOOST aerial requests
const MAX_CONCURRENT_LOADS = 8; // jobs in flight; aerial requests are budgeted separately (AERIAL_MAX_REQUESTS)
const RESELECT_DISTANCE_TILES = 0.25; // player movement (DETAIL_ZOOM tiles) that re-runs selection
const HIDDEN_TILE_LINGER_MS = 8000; // keeps tiles around for back-and-forth driving
const UNLOAD_CHECK_INTERVAL_MS = 500;
const FAILED_RETRY_MS = 10_000;
const RETRY_WHILE_WAITING_MS = 1000; // how often a waiting load re-checks for failed tiles due a retry
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
// Shared by every tile's program; driven by the day-night cycle.
const hazeColorUniform = { value: SKY_COLOR.clone() };

/** Sets the ground haze colour (slightly darker than `skyColor`). */
export function setHazeColor(skyColor) {
  hazeColorUniform.value.copy(skyColor).multiplyScalar(0.99);
}

/** onBeforeCompile hook adding the ground haze (one shared program for every tile and cloud). */
export function applyGroundHaze(shader) {
  shader.uniforms.hazeColor = hazeColorUniform;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vHazeWorldY;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHazeWorldY = (modelMatrix * vec4(transformed, 1.0)).y;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vHazeWorldY;\nuniform vec3 hazeColor;')
    .replace(
      '#include <opaque_fragment>',
      `
      float hazeDist = length(vViewPosition);
      float hazeHeight = 1.0 - smoothstep(${(HAZE_MAX_HEIGHT_METERS - 500).toFixed(1)}, ${HAZE_MAX_HEIGHT_METERS.toFixed(1)}, vHazeWorldY);
      float groundHaze = max(
        (1.0 - exp(-hazeDist / ${HAZE_DISTANCE_METERS.toFixed(1)})) * hazeHeight,
        smoothstep(${HAZE_EDGE_START_METERS.toFixed(1)}, ${FAR_RADIUS_METERS.toFixed(1)}, hazeDist)
      );
      outgoingLight = mix(outgoingLight, hazeColor, groundHaze);
      #include <opaque_fragment>`
    );
}

// Scales the PBR specular (F0 0.04, F90 1.0): even at roughness 1 the Fresnel term makes the
// ground shine when looking into a low sun. 0 = fully matte, 1 = three.js default.
const TERRAIN_SPECULAR = 0.05;

/** onBeforeCompile hook for terrain tiles: ground haze plus damped specular. */
function applyTerrainShading(shader) {
  applyGroundHaze(shader);
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <lights_physical_fragment>',
    `#include <lights_physical_fragment>
    material.specularColorBlended *= ${TERRAIN_SPECULAR.toFixed(3)};
    material.specularF90 *= ${TERRAIN_SPECULAR.toFixed(3)};`
  );
}

function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

function closeMips(mips) {
  mips?.forEach((mip) => mip.close());
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
    this.wireframeVisible = true;
    this.roadProfileVisible = true;
    this.roadBedInspection = null; // debug: { tile, vertex, record, cause, group }, see inspectRoadBedAt
    this.roadBed = true; // debug: false builds detail tiles without carved roads

    this.tiles = new Map(); // key -> { key, z, x, y, mesh, surface, body, border, wireframe, roadProfile, roadProfileLines, aerialBoost, texBytes, meshBytes, hiddenSince }
    this._loadedBelow = new Map(); // key -> number of loaded tiles strictly inside it
    this.loading = new Map(); // key -> job in flight
    this._aerialInFlight = 0; // aerial requests of the jobs in flight
    this._failedAt = new Map(); // key -> time of the last failed load
    this._noDataLogged = new Set(); // keys whose elevation no-data fallback was already logged
    this._leaves = []; // desired leaves: [{ z, x, y, key, distMeters, dirX, dirY, detail, covered }]
    this._leafKeys = new Set();
    this._visible = new Set();
    this.dissolve = null; // optional createDissolve(): shown tiles burst into particles as they go
    this._displayDirty = false; // a load finished; _updateDisplay() runs on the next update()
    this._detailWaiters = [];
    // Bumped by recenter() so in-flight loads for the old origin bail out.
    this._loadEpoch = 0;

    this._lat = originLat;
    this._lon = originLon;
    this._lastSelect = null; // DETAIL_ZOOM fractional tile coords of the last selection
    this._centerX = 0;
    this._centerY = 0;
    this._aheadTiles = []; // DETAIL_ZOOM keys the heading ray crosses next, nearest first
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

  /** Grid cell size (m) of the detail tile at (x, z), or null if not loaded. */
  detailCellAt(x, z) {
    const { lat, lon } = localToLatLon(x, z, this.originLat, this.originLon, this.scaleLat);
    const tile = this.tiles.get(tileKey(DETAIL_ZOOM, Math.floor(lon2tileX(lon, DETAIL_ZOOM)), Math.floor(lat2tileY(lat, DETAIL_ZOOM))));
    return tile?.heightfield?.elementSize ?? null;
  }

  /** Detail-tile surface y at (x, z) from its heightfield (no physics body needed), or null if not loaded. */
  detailHeightAt(x, z) {
    const { lat, lon } = localToLatLon(x, z, this.originLat, this.originLon, this.scaleLat);
    const tx = Math.floor(lon2tileX(lon, DETAIL_ZOOM));
    const ty = Math.floor(lat2tileY(lat, DETAIL_ZOOM));
    const tile = this.tiles.get(tileKey(DETAIL_ZOOM, tx, ty));
    if (!tile?.heightfield) return null;
    const { heights, cols, rows, elementSize } = tile.heightfield;
    const fx = Math.min(Math.max((x - tile.mesh.position.x) / elementSize, 0), cols - 1);
    const fz = Math.min(Math.max((z - tile.mesh.position.z) / elementSize, 0), rows - 1);
    const c = Math.min(Math.floor(fx), cols - 2);
    const r = Math.min(Math.floor(fz), rows - 2);
    const u = fx - c;
    const v = fz - r;
    const i = r * cols + c;
    const top = heights[i] * (1 - u) + heights[i + 1] * u;
    const bottom = heights[i + cols] * (1 - u) + heights[i + cols + 1] * u;
    return top * (1 - v) + bottom * v;
  }

  /**
   * Rendered ground y at (x, z) from the finest visible tile (else the finest
   * loaded one), any zoom; null if no tile covers it.
   */
  surfaceHeightAt(x, z) {
    const { lat, lon } = localToLatLon(x, z, this.originLat, this.originLon, this.scaleLat);
    const fx = lon2tileX(lon, DETAIL_ZOOM);
    const fy = lat2tileY(lat, DETAIL_ZOOM);
    const tile = this._surfaceTileAt(fx, fy);
    if (!tile) return null;
    const s = 2 ** (tile.z - DETAIL_ZOOM);
    return this._tileHeightAt(tile, x, z, fx * s, fy * s);
  }

  /** Nearest point where `raycaster` hits a shown terrain tile, or null. */
  raycast(raycaster) {
    const meshes = [];
    for (const tile of this.tiles.values()) if (tile.mesh.visible) meshes.push(tile.mesh);
    return raycaster.intersectObjects(meshes, false)[0]?.point ?? null;
  }

  /**
   * Aerial imagery colour (sRGB bytes into `out` [r, g, b]) under world (x, z)
   * from the finest loaded tile that has imagery; false if none.
   */
  groundColorAt(x, z, out) {
    const { lat, lon } = localToLatLon(x, z, this.originLat, this.originLon, this.scaleLat);
    const fx = lon2tileX(lon, DETAIL_ZOOM);
    const fy = lat2tileY(lat, DETAIL_ZOOM);
    for (let zoom = DETAIL_ZOOM; zoom >= ROOT_ZOOM; zoom--) {
      const s = 2 ** (zoom - DETAIL_ZOOM);
      const tx = fx * s;
      const ty = fy * s;
      const swatch = this.tiles.get(tileKey(zoom, Math.floor(tx), Math.floor(ty)))?.swatch;
      if (!swatch) continue;
      const { size, rgb } = swatch;
      const px = Math.min(size - 1, Math.floor((tx - Math.floor(tx)) * size));
      const py = Math.min(size - 1, Math.floor((ty - Math.floor(ty)) * size));
      const i = (py * size + px) * 3;
      out[0] = rgb[i];
      out[1] = rgb[i + 1];
      out[2] = rgb[i + 2];
      return true;
    }
    return false;
  }

  /**
   * Tile surfaceHeightAt() reads at the centre of DETAIL_ZOOM tile (tx, ty),
   * or null. Overlays compare it (and its surfaceRevision) to notice the ground changed.
   */
  surfaceTileAt(tx, ty) {
    return this._surfaceTileAt(tx + 0.5, ty + 0.5);
  }

  /** Finest visible tile at fractional DETAIL_ZOOM coords, else the finest loaded one. */
  _surfaceTileAt(fx, fy) {
    let fallback = null;
    for (let zoom = DETAIL_ZOOM; zoom >= ROOT_ZOOM; zoom--) {
      const s = 2 ** (zoom - DETAIL_ZOOM);
      const tile = this.tiles.get(tileKey(zoom, Math.floor(fx * s), Math.floor(fy * s)));
      if (!tile) continue;
      if (tile.mesh.visible) return tile;
      fallback ??= tile;
    }
    return fallback;
  }

  /** Height on one tile's triangles; (tx, ty) are fractional tile coords at its zoom. */
  _tileHeightAt(tile, x, z, tx, ty) {
    if (tile.z === DETAIL_ZOOM) return this.detailHeightAt(x, z) ?? 0;
    const { cols, rows, positions } = tile.surface;
    const gu = Math.min(Math.max((tx - tile.x) * cols, 0), cols - 1e-6);
    const gv = Math.min(Math.max((ty - tile.y) * rows, 0), rows - 1e-6);
    const ix = Math.floor(gu);
    const iy = Math.floor(gv);
    const u = gu - ix;
    const v = gv - iy;
    const row = cols + 1;
    const h = (i) => positions[i * 3 + 1];
    const a = h(iy * row + ix); // NW
    const b = h((iy + 1) * row + ix); // SW
    const c = h((iy + 1) * row + ix + 1); // SE
    const d = h(iy * row + ix + 1); // NE
    // Coarse grids split each cell along SW-NE (see buildGridMesh).
    if (u + v <= 1) return a + (d - a) * u + (b - a) * v;
    return c + (b - c) * (1 - u) + (d - c) * (1 - v);
  }

  /**
   * Teleport support: tears everything down and streams a fresh set around
   * a new lat/lon origin (the flat local projection is only accurate near
   * its origin). Resolves once the physics footprint is loaded.
   */
  async recenter(lat, lon) {
    this._loadEpoch++; // invalidate in-flight loads first
    for (const tile of Array.from(this.tiles.values())) this._disposeTile(tile);
    for (const job of this.loading.values()) job.controller.abort();
    this.loading.clear();
    this._aerialInFlight = 0; // aborted jobs' requests are cancelled; their late replies don't count
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
    this._aheadTiles = this._selectAheadTiles(px[DETAIL_ZOOM], py[DETAIL_ZOOM]);

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
    // Frees load slots and connections from tiles the player has already passed.
    for (const [key, job] of this.loading) {
      if (!this._leafKeys.has(key) || (job.playerTile && !this._wantsMaxImagery(job))) job.controller.abort();
    }
  }

  /** Keys of the DETAIL_ZOOM tiles (other than the player's) a heading ray from (fx, fy) enters within AHEAD_TILE_REACH. */
  _selectAheadTiles(fx, fy) {
    const len = Math.hypot(this._headingX, this._headingZ);
    if (!len) return [];
    const ux = this._headingX / len;
    const uy = this._headingZ / len; // local +z is south, as is tile +y
    const keys = [];
    for (let d = 0.1; d <= AHEAD_TILE_REACH && keys.length < AHEAD_TILE_MAX; d += 0.1) {
      const tx = Math.floor(fx + ux * d);
      const ty = Math.floor(fy + uy * d);
      if (tx === this._centerX && ty === this._centerY) continue;
      const key = tileKey(DETAIL_ZOOM, tx, ty);
      if (!keys.includes(key)) keys.push(key);
    }
    return keys;
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
    return tile.ancestorKeys.some((key) => visible.has(key));
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
    this._displayDirty = false;
    const visible = new Set();
    for (const leaf of this._leaves) {
      leaf.covered = true;
      const tile = this.tiles.get(leaf.key);
      if (tile) {
        // An ancestor stands in for a detail tile until its first imagery arrives.
        const ancestor = tile.aerialBoost === NO_IMAGERY && this._loadedAncestor(leaf.z, leaf.x, leaf.y);
        visible.add(ancestor || leaf.key);
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
      if (tile.mesh.visible && !show) this.dissolve?.dissolveMesh(tile.mesh);
      tile.mesh.visible = show;
      if (show) tile.hiddenSince = null;
      else if (tile.hiddenSince == null) tile.hiddenSince = now;
      this._syncDebugLines(tile);
      this._syncBody(tile);
    }
    this._visible = visible;
  }

  _syncDebugLines(tile) {
    const liftScale = 2 ** (DETAIL_ZOOM - tile.z);
    const wantBorder = this.bordersVisible && tile.mesh.visible;
    if (wantBorder && !tile.border) {
      tile.border = buildTileBorder(tile.surface, liftScale);
      tile.border.position.copy(tile.mesh.position);
      this.scene.add(tile.border);
    }
    if (tile.border) tile.border.visible = wantBorder;
    // Child of the tile mesh, so it follows the mesh's visibility.
    if (this.wireframeVisible && !tile.wireframe) {
      tile.wireframe = buildTileWireframe(tile.mesh.geometry, liftScale);
      tile.mesh.add(tile.wireframe);
    }
    if (tile.wireframe) tile.wireframe.visible = this.wireframeVisible;
    if (this.roadProfileVisible && tile.roadProfile && !tile.roadProfileLines) {
      tile.roadProfileLines = buildRoadProfileLines(tile.roadProfile, tile.surface);
      tile.mesh.add(tile.roadProfileLines);
    }
    if (tile.roadProfileLines) tile.roadProfileLines.visible = this.roadProfileVisible;
  }

  _removeRoadProfileLines(tile) {
    if (!tile.roadProfileLines) return;
    if (this.roadBedInspection?.tile === tile) this.clearRoadBedInspection();
    tile.mesh.remove(tile.roadProfileLines);
    for (const line of tile.roadProfileLines.children) line.geometry.dispose();
    tile.roadProfileLines = null;
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
   * Lower = sooner: HIGH physics tiles, their first imagery (so the ground
   * under the car never waits behind the ring), MEDIUM physics tiles, their
   * first imagery, sharper imagery, holes (coarse first, so the view fills
   * fast), then refinements. Beyond HIGH, tiles behind the player count farther.
   */
  _jobScore(leaf, kind) {
    if (leaf.playerTile) return 9e9 + (this._aheadTiles.indexOf(leaf.key) + 1); // only once nothing else is left
    const high = leaf.detail && detailLevelForOffset(leaf.x - this._centerX, leaf.y - this._centerY) === DetailLevel.HIGH;
    if (kind === 'texture') {
      if (leaf.tileBoost !== NO_IMAGERY) return 3.5e9 + this._aheadDist(leaf);
      return high ? 1e9 + leaf.distMeters : 3e9 + this._aheadDist(leaf);
    }
    if (leaf.detail) return high ? leaf.distMeters : 2e9 + this._aheadDist(leaf);
    if (!leaf.covered) return 3e9 + leaf.z * 1e7 + leaf.distMeters;
    return 5e9 + this._aheadDist(leaf);
  }

  /** distMeters, stretched up to 2x for tiles behind the player's heading. */
  _aheadDist(leaf) {
    const dirLen = Math.hypot(leaf.dirX, leaf.dirY);
    const headingLen = Math.hypot(this._headingX, this._headingZ);
    const cos =
      dirLen && headingLen ? (leaf.dirX * this._headingX + leaf.dirY * this._headingZ) / (dirLen * headingLen) : 0;
    return leaf.distMeters * (1 + 0.5 * (1 - cos));
  }

  /** Aerial requests a job makes: its mosaic's quadrant count. */
  _aerialCost(kind, aerialBoost) {
    if (kind === 'surface' || aerialBoost === NO_IMAGERY) return 0;
    return 4 ** aerialBoost;
  }

  /** Best job to start; with `aerialBudget` set, only ones needing at most that many aerial requests. */
  _nextJob(aerialBudget = Infinity) {
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
      } else if (leaf.detail && tile.roadBed !== this.roadBed) {
        const failedAt = this._failedAt.get(leaf.key);
        if (failedAt != null && now - failedAt < FAILED_RETRY_MS) continue;
        kind = 'surface';
      } else if (tile.aerialBoost < this._aerialBoost(leaf) || this._dropsPlayerTileImagery(leaf, tile)) {
        const failedAt = this._failedAt.get(leaf.key);
        if (failedAt != null && now - failedAt < FAILED_RETRY_MS) continue;
        kind = 'texture'; // only the player tile's mosaic downgrades: the rest is already paid for
      } else {
        continue;
      }
      const aerialBoost = this._nextAerialBoost(leaf, tile);
      const aerialCost = this._aerialCost(kind, aerialBoost);
      if (aerialCost && aerialCost > aerialBudget) continue; // imagery-free jobs (physics tiles) never wait on imagery
      const playerTile = kind === 'texture' && aerialBoost > AERIAL_BOOST[DetailLevel.HIGH];
      const job = { ...leaf, kind, aerialBoost, aerialCost, tileBoost: tile?.aerialBoost, playerTile };
      const score = this._jobScore(job, kind);
      if (score < bestScore) {
        bestScore = score;
        best = job;
      }
    }
    return best;
  }

  /** Imagery boost for a leaf: by detail level inside the physics circle, LOW elsewhere; never past AERIAL_MAX_ZOOM. */
  _aerialBoost(leaf) {
    if (this._wantsMaxImagery(leaf)) return PLAYER_TILE_BOOST;
    const level = leaf.detail ? detailLevelForOffset(leaf.x - this._centerX, leaf.y - this._centerY) : DetailLevel.LOW;
    return Math.max(0, Math.min(AERIAL_BOOST[level], AERIAL_MAX_ZOOM - leaf.z));
  }

  /** Boost for the next load of a leaf: none for new detail tiles, then MEDIUM and HIGH before anything sharper. */
  _nextAerialBoost(leaf, tile) {
    if (!tile) return leaf.detail ? NO_IMAGERY : AERIAL_BOOST[DetailLevel.LOW];
    const want = this._aerialBoost(leaf);
    for (const step of [AERIAL_BOOST[DetailLevel.MEDIUM], AERIAL_BOOST[DetailLevel.HIGH]]) {
      if (tile.aerialBoost < step && want > step) return step;
    }
    return want;
  }

  _isPlayerTile({ z, x, y }) {
    return z === DETAIL_ZOOM && x === this._centerX && y === this._centerY;
  }

  /** Player tile or one of the tiles ahead of it: imagery at AERIAL_MAX_ZOOM. */
  _wantsMaxImagery(leaf) {
    return this._isPlayerTile(leaf) || (leaf.z === DETAIL_ZOOM && this._aheadTiles.includes(leaf.key));
  }

  /** True for a tile still holding a player-tile mosaic after the player moved more than PLAYER_TILE_KEEP_RADIUS away (unless it's ahead). */
  _dropsPlayerTileImagery(leaf, tile) {
    if (tile.aerialBoost <= AERIAL_BOOST[DetailLevel.HIGH] || this._wantsMaxImagery(leaf)) return false;
    return Math.max(Math.abs(leaf.x - this._centerX), Math.abs(leaf.y - this._centerY)) > PLAYER_TILE_KEEP_RADIUS;
  }

  /** Starts jobs best first; once aerial requests would queue in the browser, only jobs that fit the budget. */
  _pump() {
    // The player-tile mosaic hogs every aerial connection, so any other pending job cancels it (it requeues last).
    for (const job of this.loading.values()) {
      if (job.playerTile && !job.controller.signal.aborted && this._nextJob()?.playerTile === false) job.controller.abort();
    }
    while (this.loading.size < MAX_CONCURRENT_LOADS) {
      // One job may always overshoot an idle budget, else a big mosaic could never start.
      const budget = this._aerialInFlight ? AERIAL_MAX_REQUESTS - this._aerialInFlight : Infinity;
      const job = this._nextJob(budget);
      if (!job) return;
      this._runJob(job);
    }
  }

  async _runJob(job) {
    const { z, x, y, key } = job;
    const epoch = this._loadEpoch;
    job.controller = new AbortController();
    const { signal } = job.controller;
    this.loading.set(key, job);
    this._aerialInFlight += job.aerialCost;
    try {
      if (job.kind === 'texture') {
        const { mips, swatch, aborted } = await loadTileData({ z, x, y, elevation: false, aerialBoost: job.aerialBoost, signal });
        const tile = this.tiles.get(key);
        if (aborted || epoch !== this._loadEpoch || !tile || !mips) {
          closeMips(mips);
          if (!aborted && tile && !mips) this._failedAt.set(key, performance.now()); // keeps the old texture
          return;
        }
        this._setTileTexture(tile, mips, job.aerialBoost);
        tile.swatch = swatch ?? tile.swatch;
        return;
      }
      if (job.kind === 'surface') {
        // Rebuilt in place (texture kept) so the car never loses its ground.
        const detail = this._detailParams(x, y);
        const elevationBorder = roadBedBorderPx(tileSizeMeters(z, tileY2lat(y + 0.5, z)) / 256, detail.widthMeters / detail.cells);
        const { elev, surface, aborted } = await loadTileData({ z, x, y, elevationBorder, detail, signal });
        const tile = this.tiles.get(key);
        if (aborted || epoch !== this._loadEpoch || !tile) return;
        if (surface && elev?.ok) {
          this._replaceDetailSurface(tile, surface, detail.roadBed);
          this._noteElevationFallback(tile, elev);
        } else this._failedAt.set(key, performance.now());
        return;
      }

      const { aerialBoost } = job;
      const detail = z === DETAIL_ZOOM ? this._detailParams(x, y) : null;
      const elevationBorder = detail
        ? roadBedBorderPx(tileSizeMeters(z, tileY2lat(y + 0.5, z)) / 256, detail.widthMeters / detail.cells)
        : 0;
      const imagery = aerialBoost === NO_IMAGERY ? null : aerialBoost;
      const { elev, mips, swatch, surface, aborted } = await loadTileData({ z, x, y, elevationBorder, aerialBoost: imagery, detail, signal });
      if (aborted || epoch !== this._loadEpoch || this.tiles.has(key)) {
        closeMips(mips);
        return;
      }
      const heights = detail ? (surface && elev?.ok ? surface : null) : elev?.heights ? elev : null;
      if (detail && !surface) {
        console.warn('Terrain detail surface failed', z, x, y, elev?.error);
        this._failedAt.set(key, performance.now());
        closeMips(mips);
        return;
      }
      if (!heights) {
        // Physics tiles fall back to flat (safer than a hole to fall
        // through); others retry later while an ancestor stands in.
        console.warn('Terrain elevation fetch failed', z, x, y, elev?.error);
        if (!job.detail) {
          this._failedAt.set(key, performance.now());
          closeMips(mips);
          return;
        }
      }
      const tile = detail
        ? this._addDetailTile(job, surface, mips, aerialBoost, detail.roadBed)
        : this._addTile(job, heights, mips, aerialBoost);
      tile.swatch = swatch ?? null;
      this._noteElevationFallback(tile, elev);
    } catch (err) {
      console.warn('Terrain tile failed to load', z, x, y, err);
    } finally {
      if (this.loading.get(key) === job) this.loading.delete(key);
      if (epoch === this._loadEpoch) {
        this._aerialInFlight -= job.aerialCost;
        // Batched into the next update(), unless an awaitAll caller waits on the physics footprint.
        if (this._detailWaiters.length) {
          this._updateDisplay();
          this._resolveDetailWaiters();
        } else {
          this._displayDirty = true;
        }
        this._pump();
        this._retryWhileWaiting();
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
      roadBed: this.roadBed,
    };
  }

  /** Records (and logs once) a tile whose elevation source had no data, so it stood in a coarser zoom's. */
  _noteElevationFallback(tile, elev) {
    tile.elevationFallbackZoom = elev?.fallbackZoom ?? null;
    if (tile.elevationFallbackZoom == null || this._noDataLogged.has(tile.key)) return;
    this._noDataLogged.add(tile.key);
    console.warn(`Terrain elevation has no data for ${tile.key}, using zoom ${tile.elevationFallbackZoom} instead`);
  }

  /** Detail tile from the worker's surface: positions are relative to the NW corner. */
  _addDetailTile({ z, x, y, key }, { mesh: gridMesh, cols, rows, heightfield, roadProfile }, mips, aerialBoost, roadBed) {
    const { geometry, surface } = geometryFromGridMesh(gridMesh, cols, rows);
    const nw = latLonToLocal(tileY2lat(y, z), tileX2lon(x, z), this.originLat, this.originLon, this.scaleLat);
    const tile = this._createTileMesh({ z, x, y, key }, geometry, surface, { x: nw.x, y: 0, z: nw.z }, mips, aerialBoost);
    tile.heightfield = heightfield;
    tile.roadBed = roadBed;
    tile.roadProfile = roadProfile;
    this._syncDebugLines(tile);
    return tile;
  }

  /** Swaps a detail tile's mesh geometry, heightfield and physics body for a rebuilt surface. */
  _replaceDetailSurface(tile, { mesh: gridMesh, cols, rows, heightfield, roadProfile }, roadBed) {
    const { geometry, surface } = geometryFromGridMesh(gridMesh, cols, rows);
    tile.mesh.geometry.dispose();
    tile.mesh.geometry = geometry;
    tile.surface = surface;
    tile.heightfield = heightfield;
    tile.roadBed = roadBed;
    tile.roadProfile = roadProfile;
    this._removeRoadProfileLines(tile);
    tile.surfaceRevision++;
    this._failedAt.delete(tile.key);
    tile.meshBytes = Object.values(geometry.attributes).reduce((n, attr) => n + attr.array.byteLength, geometry.index.array.byteLength);
    if (tile.border) {
      this.scene.remove(tile.border);
      tile.border.geometry.dispose();
      tile.border = null;
    }
    if (tile.wireframe) {
      tile.mesh.remove(tile.wireframe); // shares the (already disposed) tile geometry
      tile.wireframe = null;
    }
    if (tile.body) {
      this.world.removeBody(tile.body);
      tile.body = null;
    }
    this._syncDebugLines(tile);
    this._syncBody(tile);
  }

  _addTile({ z, x, y, key }, elev, mips, aerialBoost) {
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
    return this._createTileMesh({ z, x, y, key }, geometry, surface, anchor, mips, aerialBoost);
  }

  _createTileMesh({ z, x, y, key }, geometry, surface, anchor, mips, aerialBoost) {
    const material = new THREE.MeshStandardMaterial({ roughness: 1, fog: false });
    material.onBeforeCompile = applyTerrainShading;
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
      swatch: null, // { size, rgb }: low-res imagery colours (tileWorker.js)
      surfaceRevision: 0, // bumped when the surface is rebuilt in place
      body: null,
      lines: null,
      aerialBoost: 0,
      texBytes: 0,
      meshBytes,
      hiddenSince: performance.now(),
    };
    tile.ancestorKeys = this._ancestorKeys(tile);
    this._setTileTexture(tile, mips, aerialBoost);
    this.tiles.set(key, tile);
    for (const k of tile.ancestorKeys) this._loadedBelow.set(k, (this._loadedBelow.get(k) || 0) + 1);
    this._failedAt.delete(key);
    this.stats[z === DETAIL_ZOOM ? 'detail' : 'coarse'].created++;
    return tile;
  }

  /** Swaps in a texture from the worker's mip chain (none: untextured); the bitmaps are freed once on the GPU. */
  _setTileTexture(tile, mips, aerialBoost) {
    const material = tile.mesh.material;
    const old = material.map;
    if (mips) {
      const tex = new THREE.Texture(mips[0]);
      tex.mipmaps = mips;
      tex.generateMipmaps = false;
      tex.flipY = false; // ignored for ImageBitmap anyway; UVs account for it
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.onUpdate = () => closeMips(mips);
      tex.needsUpdate = true;
      material.map = tex;
      tile.texBytes = Math.round(mips[0].width * mips[0].height * 4 * (4 / 3)); // + mipmaps
      if (!old) material.needsUpdate = true;
    }
    if (old && old !== material.map) {
      closeMips(old.mipmaps);
      old.dispose();
    }
    tile.aerialBoost = aerialBoost;
  }

  _disposeTile(tile) {
    if (tile.mesh.visible) this.dissolve?.dissolveMesh(tile.mesh);
    this.scene.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    const map = tile.mesh.material.map;
    if (map) {
      closeMips(map.mipmaps); // if never uploaded
      map.dispose();
    }
    tile.mesh.material.dispose();
    if (tile.border) {
      this.scene.remove(tile.border);
      tile.border.geometry.dispose();
    }
    this._removeRoadProfileLines(tile);
    if (tile.body) this.world.removeBody(tile.body);
    this.tiles.delete(tile.key);
    for (const k of tile.ancestorKeys) {
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

  /**
   * Pending work for the streaming indicator: jobs in flight plus desired tiles not loaded or started
   * (failed ones waiting to retry excluded), all downloads - a finished job installs at once.
   */
  pendingWork() {
    const now = performance.now();
    let missing = 0;
    for (const { key } of this._leaves) {
      if (this.tiles.has(key) || this.loading.has(key)) continue;
      const failedAt = this._failedAt.get(key);
      if (failedAt == null || now - failedAt >= FAILED_RETRY_MS) missing++;
    }
    return { downloads: this.loading.size + missing, builds: 0 };
  }

  /** Startup progress for the loading screen: baseline sample, then the physics footprint init() waits on. */
  getLoadProgress() {
    let physicsLoaded = 0;
    if (this._lastSelect) {
      for (const { dx, dy } of DETAIL_OFFSETS) {
        if (this.tiles.get(tileKey(DETAIL_ZOOM, this._centerX + dx, this._centerY + dy))?.body) physicsLoaded++;
      }
    }
    let farLoaded = 0;
    for (const tile of this.tiles.values()) if (tile.z !== DETAIL_ZOOM) farLoaded++;
    return {
      baselineReady: this._heightBaselineSet,
      physicsLoaded,
      physicsTotal: DETAIL_OFFSETS.length,
      farLoaded,
      inFlight: this.loading.size,
    };
  }

  /** The main loop doesn't stream while an awaitAll caller waits (teleport), so retry failed tiles from here. */
  _retryWhileWaiting() {
    if (!this._detailWaiters.length || this.loading.size || this._retryTimer) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._pump();
      this._retryWhileWaiting();
    }, RETRY_WHILE_WAITING_MS);
  }

  _resolveDetailWaiters() {
    if (!this._detailWaiters.length || !this._allPhysicsLoaded()) return;
    const waiters = this._detailWaiters;
    this._detailWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /** Toggles debug tile border loops on current and future tiles. */
  setBordersVisible(visible) {
    this.bordersVisible = visible;
    for (const tile of this.tiles.values()) this._syncDebugLines(tile);
  }

  /** Debug: builds detail tiles with or without the carved road bed; loaded tiles rebuild in place. */
  setRoadBedEnabled(enabled) {
    if (enabled === this.roadBed) return;
    this.roadBed = enabled;
    this._pump();
  }

  /** Toggles the debug road centreline profiles (original terrain vs road height) on detail tiles. */
  setRoadProfileVisible(visible) {
    this.roadProfileVisible = visible;
    for (const tile of this.tiles.values()) this._syncDebugLines(tile);
  }

  /**
   * Debug: selects the road-bed-moved vertex whose profile dot is nearest screen point (sx, sy) of a
   * `width` x `height` view, within `maxPx`, and draws lines to what moved it. Clears the old one either way.
   */
  inspectRoadBedAt(camera, sx, sy, width, height, maxPx) {
    this.clearRoadBedInspection();
    if (!this.roadProfileVisible) return null;
    let best = { dist: maxPx };
    let bestTile = null;
    for (const tile of this.tiles.values()) {
      const causes = tile.roadProfile?.causes;
      if (!causes || !tile.roadProfileLines || !tile.mesh.visible) continue;
      const pick = pickCauseDot(tile.mesh, tile.surface, causes, camera, sx, sy, width, height, best);
      if (pick === best) continue;
      best = pick;
      bestTile = tile;
    }
    if (!bestTile) return null;
    const { vertex } = best;
    const { causes, records } = bestTile.roadProfile;
    const group = buildRoadBedSources(bestTile.surface, vertex, records[vertex], causes[vertex]);
    bestTile.roadProfileLines.add(group);
    this.roadBedInspection = { tile: bestTile, vertex, record: records[vertex], cause: causes[vertex], group };
    return this.roadBedInspection;
  }

  /** Debug: the inspected vertex (inspectRoadBedAt) with its world `position` and whether it's `shown`, or null. */
  getRoadBedInspection() {
    const inspection = this.roadBedInspection;
    if (!inspection) return null;
    const { tile, vertex, record, cause } = inspection;
    const position = causeDotWorldPosition(tile.mesh, tile.surface, vertex, new THREE.Vector3());
    return { record, cause, position, shown: tile.mesh.visible && tile.roadProfileLines.visible };
  }

  clearRoadBedInspection() {
    if (!this.roadBedInspection) return;
    disposeRoadBedSources(this.roadBedInspection.group);
    this.roadBedInspection = null;
  }

  /** Toggles the debug wireframe of the rendered terrain triangles on current and future tiles. */
  setWireframeVisible(visible) {
    this.wireframeVisible = visible;
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
    } else if (this._displayDirty) {
      this._updateDisplay();
    }

    const now = performance.now();
    if (now - this._lastUnloadCheck > UNLOAD_CHECK_INTERVAL_MS) {
      this._lastUnloadCheck = now;
      this._unloadStale(now);
    }

    if (awaitAll && !this._allPhysicsLoaded()) {
      const loaded = new Promise((resolve) => this._detailWaiters.push(resolve));
      this._retryWhileWaiting();
      await loaded;
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
    let elevationFallbacks = 0;
    for (const tile of this.tiles.values()) {
      const b = tile.z === DETAIL_ZOOM ? buckets.detail : buckets.far;
      b.loaded++;
      if (tile.elevationFallbackZoom != null) elevationFallbacks++;
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
        const tile = this.tiles.get(key);
        let maxImagery = null;
        if (tile && tile.aerialBoost > AERIAL_BOOST[DetailLevel.HIGH]) maxImagery = 'loaded';
        else if (this._wantsMaxImagery({ z: DETAIL_ZOOM, x: tx, y: ty, key })) maxImagery = 'planned';
        const elevationFallback = tile?.elevationFallbackZoom != null;
        row.push({ tx, ty, state: dx === 0 && dy === 0 ? 'player' : state, level: detailLevelForOffset(dx, dy), maxImagery, elevationFallback });
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
      elevationFallbacks,
      far: { ...buckets.far, created: this.stats.coarse.created, removed: this.stats.coarse.removed },
    };
  }
}
