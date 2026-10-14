import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  lon2tileX,
  lat2tileY,
  tileX2lon,
  tileY2lat,
  latLonToLocal,
  localToLatLon,
  tileSizeMeters,
} from './geo.js';

// Free, keyless aerial imagery (also used by the minimap).
export const AERIAL_URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

// AWS Terrarium elevation tiles. Must use the virtual-hosted-style bucket
// URL: the path-style one returns no CORS headers, tainting the canvas.
const ELEVATION_URL = (z, x, y) =>
  `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;

// Two tiers, both selected in a circle around the player with delayed unload:
//   - detail: aerial-textured mesh (+ physics for HIGH/MEDIUM), split into
//     HIGH (3x3 around the player), MEDIUM (to DETAIL_RADIUS) and LOW (an
//     outer terrain-only ring to LOW_DETAIL_RADIUS: coarser mesh, no physics);
//   - far: coarse, untextured, physics-less backdrop to FAR_RADIUS_METERS.
// Other streamers (buildings, vector overlays) align to DETAIL_ZOOM and use
// DETAIL_RADIUS / HIGH_DETAIL_RADIUS; the LOW ring is terrain-only.

export const DETAIL_ZOOM = 15; // ~600-800m tiles at mid latitudes
const DETAIL_GRID = 16; // mesh subdivisions per tile edge
export const DETAIL_RADIUS = 2; // tiles
export const UNLOAD_MARGIN = 1; // tiles of slack before unloading
export const HIGH_DETAIL_RADIUS = 1; // square, i.e. the 3x3 block
export const LOW_DETAIL_RADIUS = DETAIL_RADIUS + 15;
const LOW_DETAIL_GRID = Math.max(1, Math.round(DETAIL_GRID / 4)); // 1/16 the vertices
export const DetailLevel = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

/** DetailLevel of a tile at (dx, dy) from the player's tile. */
export function detailLevelForOffset(dx, dy) {
  if (Math.abs(dx) <= HIGH_DETAIL_RADIUS && Math.abs(dy) <= HIGH_DETAIL_RADIUS) return DetailLevel.HIGH;
  if (inCircle(dx, dy, DETAIL_RADIUS)) return DetailLevel.MEDIUM;
  return DetailLevel.LOW;
}

// Used by the debug stats HUD grid (terrainStatsHud.js).
export const DETAIL_LEVEL_COLORS = {
  [DetailLevel.HIGH]: 0x39ff14, // bright green
  [DetailLevel.MEDIUM]: 0x2e8b22, // medium green
  [DetailLevel.LOW]: 0x6f8f6a, // desaturated green/"green-grey"
};


// Rounds circle selection out a bit so small radii don't look spiky.
const CIRCLE_SLACK = 0.5;

// Out-of-range chunks wait this many update() ticks before unloading
// (absorbs boundary flicker; shown as "removing" in the debug HUD).
export const UNLOAD_DELAY_TICKS = 3;

const FAR_ZOOM = 11; // tiles tens of km across
const FAR_GRID = 11;
export const FAR_RADIUS_METERS = 120_000;
// Radius of the hole cut in the far tier around the player (so it never
// overlaps the detail tier), in DETAIL_ZOOM tiles.
export const FAR_HOLE_RADIUS_TILES = LOW_DETAIL_RADIUS + UNLOAD_MARGIN - 2;
const FAR_UNLOAD_MARGIN = 1;
const FAR_UNLOAD_DELAY_TICKS = 3;
const FAR_Y_OFFSET = -3; // sits below the detail tier so it loses any z-fight
const FAR_FADE_IN_MS = 600;
const TILE_FADE_IN_MS = 600; // LOW-ring fade-in

// Imagery is fetched at a higher zoom than the mesh and stitched into a
// mosaic, since that's what makes the ground look sharp up close.
const AERIAL_ZOOM_BOOST = 2; // 4x4 child tiles = 1024x1024 texture per chunk
const AERIAL_TILE_SIZE = 256;

// Terrain-only collision group, for ground raycasts that ignore vehicles.
export const GROUND_COLLISION_GROUP = 2;
export const GROUND_MATERIAL = new CANNON.Material('ground');

const _groundRayFrom = new CANNON.Vec3();
const _groundRayTo = new CANNON.Vec3();
const _groundRayResult = new CANNON.RaycastResult();
// Tall enough to find the surface even from a body sunk deep underground.
export const GROUND_SEARCH_HEIGHT = 5000;

/** Terrain surface y at (x, z), or null if no chunk is loaded there. */
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

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${url}`));
    img.src = url;
  });
}

function decodeElevationTile(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  return { data, width: img.width, height: img.height };
}

function sampleHeight({ data, width, height }, u, v) {
  const px = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
  const py = Math.min(height - 1, Math.max(0, Math.round(v * (height - 1))));
  const idx = (py * width + px) * 4;
  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  // Terrarium decoding formula (Mapzen): (R*256 + G + B/256) - 32768.
  return r * 256 + g + b / 256 - 32768;
}

/**
 * One texture for tile (z, x, y), stitched from its child tiles at
 * z + zoomBoost. Failed child tiles are left blank. LOW tiles pass 0.
 */
async function loadAerialTexture(z, x, y, zoomBoost = AERIAL_ZOOM_BOOST) {
  const n = 2 ** zoomBoost;
  const zz = z + zoomBoost;
  const size = n * AERIAL_TILE_SIZE;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const loads = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const cx = x * n + i;
      const cy = y * n + j;
      loads.push(
        loadImage(AERIAL_URL(zz, cx, cy))
          .then((img) => ctx.drawImage(img, i * AERIAL_TILE_SIZE, j * AERIAL_TILE_SIZE))
          .catch(() => {}) // leave that quadrant blank on failure
      );
    }
  }
  await Promise.all(loads);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Rough memory estimate of a chunk (texture + vertex/index buffers + physics copy), for the debug HUD. */
function estimateChunkBytes(textureImage, positions, indices, hasPhysics = true) {
  const texBytes = (textureImage.width || 0) * (textureImage.height || 0) * 4;
  const vertexCount = positions.length / 3;
  const physicsFactor = hasPhysics ? 2 : 1; // Trimesh keeps its own copy
  const meshBytes = (positions.length * physicsFactor + vertexCount * 2) * 4;
  const indexBytes = indices.length * 4 * physicsFactor;
  return texBytes + meshBytes + indexBytes;
}

// Debug tile lines, lifted along vertex normals to avoid z-fighting; the
// border sits above the grid. Fat lines (LineMaterial) because WebGL
// ignores `linewidth` on basic lines; they need the viewport resolution.
const BORDER_LIFT = 0.15;
const GRID_LIFT = 0.1;
const BORDER_COLOR = 0xffe14d;
const GRID_COLOR = 0xffe14d;
const BORDER_LINEWIDTH = 3; // px
const GRID_LINEWIDTH = 1.25; // px
const borderMaterial = new LineMaterial({
  color: BORDER_COLOR,
  linewidth: BORDER_LINEWIDTH,
  transparent: true,
  opacity: 0.85,
});
const gridMaterial = new LineMaterial({
  color: GRID_COLOR,
  linewidth: GRID_LINEWIDTH,
  transparent: true,
  opacity: 0.25,
});
function updateLineResolution() {
  borderMaterial.resolution.set(window.innerWidth, window.innerHeight);
  gridMaterial.resolution.set(window.innerWidth, window.innerHeight);
}
updateLineResolution();
window.addEventListener('resize', updateLineResolution);

/** Line loop around the perimeter of a displaced tile plane. */
function buildTileBorder(geometry, grid) {
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const perimeter = [];
  for (let ix = 0; ix <= grid; ix++) perimeter.push(ix); // top edge, iy = 0, left -> right
  for (let iy = 1; iy <= grid; iy++) perimeter.push(iy * (grid + 1) + grid); // right edge, top -> bottom
  for (let ix = grid - 1; ix >= 0; ix--) perimeter.push(grid * (grid + 1) + ix); // bottom edge, right -> left
  for (let iy = grid - 1; iy >= 1; iy--) perimeter.push(iy * (grid + 1)); // left edge, bottom -> top

  // One independent segment per consecutive vertex pair (wrapping).
  const segments = new Float32Array(perimeter.length * 6);
  for (let i = 0; i < perimeter.length; i++) {
    const a = perimeter[i];
    const b = perimeter[(i + 1) % perimeter.length];
    segments[i * 6] = position.getX(a) + normal.getX(a) * BORDER_LIFT;
    segments[i * 6 + 1] = position.getY(a) + normal.getY(a) * BORDER_LIFT;
    segments[i * 6 + 2] = position.getZ(a) + normal.getZ(a) * BORDER_LIFT;
    segments[i * 6 + 3] = position.getX(b) + normal.getX(b) * BORDER_LIFT;
    segments[i * 6 + 4] = position.getY(b) + normal.getY(b) * BORDER_LIFT;
    segments[i * 6 + 5] = position.getZ(b) + normal.getZ(b) * BORDER_LIFT;
  }

  const borderGeometry = new LineSegmentsGeometry();
  borderGeometry.setPositions(segments);
  return new LineSegments2(borderGeometry, borderMaterial);
}

/** Lines along every (deduplicated) triangle edge of a tile mesh. */
function buildTileGrid(geometry) {
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const index = geometry.index.array;

  const seen = new Set();
  const segmentList = [];
  const pushEdge = (a, b) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    segmentList.push(a, b);
  };
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i];
    const b = index[i + 1];
    const c = index[i + 2];
    pushEdge(a, b);
    pushEdge(b, c);
    pushEdge(c, a);
  }

  const segments = new Float32Array(segmentList.length * 3);
  for (let i = 0; i < segmentList.length; i++) {
    const idx = segmentList[i];
    segments[i * 3] = position.getX(idx) + normal.getX(idx) * GRID_LIFT;
    segments[i * 3 + 1] = position.getY(idx) + normal.getY(idx) * GRID_LIFT;
    segments[i * 3 + 2] = position.getZ(idx) + normal.getZ(idx) * GRID_LIFT;
  }

  const gridGeometry = new LineSegmentsGeometry();
  gridGeometry.setPositions(segments);
  return new LineSegments2(gridGeometry, gridMaterial);
}

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

// Uniform far-tier colour, equal to the fog colour (sceneSetup.js) so the
// LOW tier fogs out into it with no seam.
export const FAR_BASE_COLOR = new THREE.Color(0.37, 0.61, 0.57).getHex();

// Sky colour; lives here because sceneSetup.js already imports this module.
export const SKY_COLOR = new THREE.Color(0x87ceeb);

// Ground haze on top of scene.fog: grows with distance (HAZE_START..END)
// and fades out with altitude above HAZE_MAX_HEIGHT, so peaks poke through.
// Applied to every terrain material; in practice only FAR chunks reach it.
const HAZE_START_METERS = 10_000;
const HAZE_END_METERS = FAR_RADIUS_METERS;
const HAZE_MAX_HEIGHT_METERS = 10_000; // world y (relative to the fixed origin baseline)
const HAZE_COLOR = SKY_COLOR.clone().multiplyScalar(0.99);

/** onBeforeCompile hook adding the ground haze; chainable with other injections. */
function applyGroundHaze(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vHazeWorldY;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHazeWorldY = position.y;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vHazeWorldY;')
    .replace(
      '#include <opaque_fragment>',
      `
      float hazeDist = smoothstep(${HAZE_START_METERS.toFixed(1)}, ${HAZE_END_METERS.toFixed(1)}, length(vViewPosition));
      float hazeHeight = 1.0 - smoothstep(${(HAZE_MAX_HEIGHT_METERS - 500).toFixed(1)}, ${HAZE_MAX_HEIGHT_METERS.toFixed(1)}, vHazeWorldY);
      float groundHaze = hazeDist * hazeHeight;
      outgoingLight = mix(outgoingLight, vec3(${HAZE_COLOR.r.toFixed(3)}, ${HAZE_COLOR.g.toFixed(3)}, ${HAZE_COLOR.b.toFixed(3)}), groundHaze);
      #include <opaque_fragment>`
    );
}

/**
 * Streams real-world terrain as Web Mercator tile chunks around the player
 * (see the tier overview at the top). HIGH/MEDIUM chunks get a Trimesh body
 * built from the exact render vertices, so collision matches visuals.
 */
export class TerrainManager {
  constructor(scene, world, originLat, originLon) {
    this.scene = scene;
    this.world = world;
    this.originLat = originLat;
    this.originLon = originLon;
    this.chunks = new Map(); // key -> { mesh, body, border, grid, tx, ty, bytes, level, fadeStart }
    this.pending = new Set(); // keys being fetched/built right now
    this.pendingRemoval = new Map(); // key -> ticks before unload
    // Detail chunks load strictly one at a time via a priority queue (see
    // _pumpQueue). _queueWaiters holds resolvers for queued/in-flight keys.
    this._loadQueue = []; // [{ tx, ty, key, rebuild? }]
    this._queueWaiters = new Map(); // key -> Array<() => void>
    this._pumping = false;
    // Bumped by recenter() so in-flight loads for the old origin bail out.
    this._loadEpoch = 0;
    this.heightOffset = 0; // subtracted from raw elevation so origin sits near y=0
    this._heightBaselineSet = false; // see init()
    this._lastCenter = null;
    this._centerX = 0;
    this._centerY = 0;
    // Player heading (local XZ) for LOW-ring queue priority; 0 = no bias.
    this._headingX = 0;
    this._headingZ = 0;
    this.stats = { created: 0, removed: 0 };
    this.bordersVisible = true;

    this.farChunks = new Map(); // key -> { mesh, tx, ty, bytes, fadeStart }
    this.farPending = new Set();
    this.farPendingRemoval = new Map();
    this.farStats = { created: 0, removed: 0 };
    this._lastFarCenter = null;
    this._farCenterX = 0;
    this._farCenterY = 0;
    this.farRadiusTiles = FAR_RADIUS_METERS / tileSizeMeters(FAR_ZOOM, originLat);

    // Far tiles are far bigger than the detail area, so tile exclusion
    // can't keep them from under the player: the far shader discards a
    // circle around the player instead. Uniforms are shared by all far chunks.
    const holeRadiusMeters = FAR_HOLE_RADIUS_TILES * tileSizeMeters(DETAIL_ZOOM, originLat);
    this.holeUniforms = {
      center: { value: new THREE.Vector2(0, 0) },
      radiusSq: { value: holeRadiusMeters * holeRadiusMeters },
    };
  }

  /**
   * Samples the height baseline once, at the app's fixed shared origin, so
   * world y means the same real elevation for every client (recenter()
   * must not re-baseline). Falls back to 0 on fetch failure. Then loads the
   * initial detail batch.
   */
  async init() {
    if (!this._heightBaselineSet) {
      const tx = Math.floor(lon2tileX(this.originLon, DETAIL_ZOOM));
      const ty = Math.floor(lat2tileY(this.originLat, DETAIL_ZOOM));
      try {
        const img = await loadImage(ELEVATION_URL(DETAIL_ZOOM, tx, ty));
        const grid = decodeElevationTile(img);
        const u = lon2tileX(this.originLon, DETAIL_ZOOM) - tx;
        const v = lat2tileY(this.originLat, DETAIL_ZOOM) - ty;
        this.heightOffset = sampleHeight(grid, u, v);
      } catch (err) {
        console.warn('Origin elevation fetch failed, defaulting height baseline to 0', err);
        this.heightOffset = 0;
      }
      this._heightBaselineSet = true;
    }
    await this.update(0, 0, true);
  }

  _key(tx, ty) {
    return `${tx}_${ty}`;
  }

  /** True once a tile's mesh is built - for the debug stats HUD. */
  isTileLoaded(tx, ty) {
    return this.chunks.has(this._key(tx, ty));
  }

  /**
   * Teleport support: tears everything down and streams a fresh set around
   * a new lat/lon origin (the flat local projection is only accurate near
   * its origin). Resolves once the initial batch is loaded.
   */
  async recenter(lat, lon) {
    this._loadEpoch++; // invalidate in-flight loads first
    for (const key of Array.from(this.chunks.keys())) this._unloadChunk(key);
    for (const key of Array.from(this.farChunks.keys())) this._unloadFarChunk(key);
    this.pending.clear();
    this.pendingRemoval.clear();
    this.farPending.clear();
    this.farPendingRemoval.clear();
    // Resolve outstanding waiters so an awaitAll update() never hangs.
    this._loadQueue = [];
    for (const waiters of this._queueWaiters.values()) waiters.forEach((resolve) => resolve());
    this._queueWaiters.clear();
    this._lastCenter = null;
    this._centerX = 0;
    this._centerY = 0;
    this._lastFarCenter = null;
    this._farCenterX = 0;
    this._farCenterY = 0;

    this.originLat = lat;
    this.originLon = lon;
    this.farRadiusTiles = FAR_RADIUS_METERS / tileSizeMeters(FAR_ZOOM, lat);
    const holeRadiusMeters = FAR_HOLE_RADIUS_TILES * tileSizeMeters(DETAIL_ZOOM, lat);
    this.holeUniforms.radiusSq.value = holeRadiusMeters * holeRadiusMeters;

    await this.init();
  }

  /**
   * Queue priority, lower = sooner: HIGH 0, MEDIUM 1, LOW in [2, 4) by
   * angle from the player's heading (ahead first, behind last; 3 if unknown).
   */
  _queuePriorityRank(tx, ty) {
    const dx = tx - this._centerX;
    const dy = ty - this._centerY;
    const level = detailLevelForOffset(dx, dy);
    if (level === DetailLevel.HIGH) return 0;
    if (level === DetailLevel.MEDIUM) return 1;
    const dist = Math.hypot(dx, dy);
    const headingMag = Math.hypot(this._headingX, this._headingZ);
    if (dist === 0 || headingMag === 0) return 3;
    const cosAngle = (dx * this._headingX + dy * this._headingZ) / (dist * headingMag);
    return 2 + (1 - cosAngle);
  }

  /** Queues (tx, ty) once; resolves when it's loaded. Safe to call every tick. */
  _enqueueLoad(tx, ty) {
    const key = this._key(tx, ty);
    if (this.chunks.has(key)) return Promise.resolve();
    let waiters = this._queueWaiters.get(key);
    if (!waiters) {
      waiters = [];
      this._queueWaiters.set(key, waiters);
      this._loadQueue.push({ tx, ty, key });
    }
    const promise = new Promise((resolve) => waiters.push(resolve));
    this._pumpQueue();
    return promise;
  }

  /**
   * Queues a rebuild of a loaded tile at its new detail level (MEDIUM<->LOW).
   * The old mesh/body stay live until the replacement is ready (no gap).
   */
  _enqueueRebuild(tx, ty) {
    const key = this._key(tx, ty);
    let waiters = this._queueWaiters.get(key);
    if (!waiters) {
      waiters = [];
      this._queueWaiters.set(key, waiters);
      this._loadQueue.push({ tx, ty, key, rebuild: true });
    }
    const promise = new Promise((resolve) => waiters.push(resolve));
    this._pumpQueue();
    return promise;
  }

  /**
   * Drains the queue one tile at a time, always picking the current best
   * priority (recomputed per pick, so it follows the moving player).
   * Re-entrant calls are no-ops.
   */
  async _pumpQueue() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      let next;
      while ((next = this._dequeueNext())) {
        const { tx, ty, key, rebuild } = next;
        // Waiters stay registered during the load so new callers for an
        // in-flight tile join them instead of re-queueing it.
        if (
          (!rebuild && this.chunks.has(key)) ||
          !inCircle(tx - this._centerX, ty - this._centerY, LOW_DETAIL_RADIUS)
        ) {
          this._resolveQueueWaiters(key);
          continue;
        }
        await this._loadChunk(tx, ty, rebuild);
        this._resolveQueueWaiters(key);
      }
    } finally {
      this._pumping = false;
    }
  }

  _resolveQueueWaiters(key) {
    const waiters = this._queueWaiters.get(key);
    this._queueWaiters.delete(key);
    waiters?.forEach((resolve) => resolve());
  }

  /** Removes and returns the best (lowest rank, then nearest) queue entry, or null. */
  _dequeueNext() {
    let bestIdx = -1;
    let bestRank = Infinity;
    let bestDistSq = Infinity;
    for (let i = 0; i < this._loadQueue.length; i++) {
      const { tx, ty } = this._loadQueue[i];
      const rank = this._queuePriorityRank(tx, ty);
      const dx = tx - this._centerX;
      const dy = ty - this._centerY;
      const distSq = dx * dx + dy * dy;
      if (rank < bestRank || (rank === bestRank && distSq < bestDistSq)) {
        bestRank = rank;
        bestDistSq = distSq;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) return null;
    return this._loadQueue.splice(bestIdx, 1)[0];
  }

  async _loadChunk(tx, ty, rebuild = false) {
    const key = this._key(tx, ty);
    if ((this.chunks.has(key) && !rebuild) || this.pending.has(key)) return;
    const oldChunk = rebuild ? this.chunks.get(key) : null; // replaced only once the new one is ready
    const epoch = this._loadEpoch;
    this.pending.add(key);
    try {
      // LOW: quarter-density mesh, single native aerial tile, no physics.
      const level = detailLevelForOffset(tx - this._centerX, ty - this._centerY);
      const gridRes = level === DetailLevel.LOW ? LOW_DETAIL_GRID : DETAIL_GRID;
      const aerialZoomBoost = level === DetailLevel.LOW ? 0 : undefined;

      // Elevation failure -> flat patch (safer than a hole to fall through).
      const [colorTex, elevImg] = await Promise.all([
        loadAerialTexture(DETAIL_ZOOM, tx, ty, aerialZoomBoost),
        loadImage(ELEVATION_URL(DETAIL_ZOOM, tx, ty)).catch((err) => {
          console.warn('Detail chunk elevation fetch failed, using flat fallback', tx, ty, err);
          return null;
        }),
      ]);
      const elevGrid = elevImg ? decodeElevationTile(elevImg) : null;

      if (epoch !== this._loadEpoch) return; // recentered meanwhile

      const geometry = new THREE.PlaneGeometry(1, 1, gridRes, gridRes);
      const position = geometry.attributes.position;
      for (let iy = 0; iy <= gridRes; iy++) {
        for (let ix = 0; ix <= gridRes; ix++) {
          const idx = iy * (gridRes + 1) + ix;
          const u = ix / gridRes;
          const v = iy / gridRes;
          const lon = tileX2lon(tx + u, DETAIL_ZOOM);
          const lat = tileY2lat(ty + v, DETAIL_ZOOM);
          const { x, z } = latLonToLocal(lat, lon, this.originLat, this.originLon);
          const y = elevGrid ? sampleHeight(elevGrid, u, v) - this.heightOffset : 0;
          position.setXYZ(idx, x, y, z);
        }
      }
      position.needsUpdate = true;
      geometry.computeVertexNormals();

      const material = new THREE.MeshStandardMaterial({ map: colorTex, roughness: 1 });
      material.onBeforeCompile = applyGroundHaze;
      // New LOW tiles fade in (_updateChunkFades); not rebuilds, whose old
      // mesh is still visible until the swap.
      const fadeIn = !rebuild && level === DetailLevel.LOW;
      if (fadeIn) {
        material.transparent = true;
        material.opacity = 0;
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.receiveShadow = true;
      this.scene.add(mesh);

      // Debug lines: tile border + mesh triangle edges.
      const border = buildTileBorder(geometry, gridRes);
      border.visible = this.bordersVisible;
      this.scene.add(border);
      const grid = buildTileGrid(geometry);
      grid.visible = this.bordersVisible;
      this.scene.add(grid);

      // Trimesh from the same world-space vertices as the mesh.
      let body = null;
      if (level !== DetailLevel.LOW) {
        const vertices = Array.from(position.array);
        const indices = Array.from(geometry.index.array);
        const shape = new CANNON.Trimesh(vertices, indices);
        body = new CANNON.Body({ mass: 0, material: GROUND_MATERIAL });
        body.collisionFilterGroup = GROUND_COLLISION_GROUP;
        body.addShape(shape);
        this.world.addBody(body);
      }

      const bytes =
        estimateChunkBytes(colorTex.image, position.array, geometry.index.array, level !== DetailLevel.LOW) +
        (border.geometry.attributes.instanceStart.data.array.length +
          grid.geometry.attributes.instanceStart.data.array.length) *
          4;

      this.chunks.set(key, {
        mesh,
        body,
        border,
        grid,
        tx,
        ty,
        bytes,
        level,
        fadeStart: fadeIn ? performance.now() : null,
      });
      this.stats.created++;
      if (oldChunk) {
        this._disposeChunkResources(oldChunk);
        this.stats.removed++;
      }
    } catch (err) {
      console.warn('Terrain chunk failed to load', tx, ty, err);
    } finally {
      this.pending.delete(key);
    }
  }

  /** Frees a chunk's render/physics resources (no bookkeeping). Line materials are shared, never disposed. */
  _disposeChunkResources(chunk) {
    this.scene.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    chunk.mesh.material.map?.dispose();
    chunk.mesh.material.dispose();
    this.scene.remove(chunk.border);
    chunk.border.geometry.dispose();
    this.scene.remove(chunk.grid);
    chunk.grid.geometry.dispose();
    if (chunk.body) this.world.removeBody(chunk.body);
  }

  _unloadChunk(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this._disposeChunkResources(chunk);
    this.chunks.delete(key);
    this.pendingRemoval.delete(key);
    this.stats.removed++;
  }

  /** Eases fading LOW chunks to opaque over TILE_FADE_IN_MS; runs every frame. */
  _updateChunkFades() {
    if (!this.chunks.size) return;
    const now = performance.now();
    for (const chunk of this.chunks.values()) {
      if (chunk.fadeStart == null) continue;
      const t = Math.min(1, (now - chunk.fadeStart) / TILE_FADE_IN_MS);
      chunk.mesh.material.opacity = t;
      if (t >= 1) chunk.fadeStart = null;
    }
  }

  /** Far chunk: elevation-only coarse mesh, flat colour, no physics; flat on fetch failure. */
  async _loadFarChunk(tx, ty) {
    const key = this._key(tx, ty);
    if (this.farChunks.has(key) || this.farPending.has(key)) return;
    const epoch = this._loadEpoch;
    this.farPending.add(key);
    try {
      const elevImg = await loadImage(ELEVATION_URL(FAR_ZOOM, tx, ty)).catch((err) => {
        console.warn('Far chunk elevation fetch failed, using flat fallback', tx, ty, err);
        return null;
      });
      const elevGrid = elevImg ? decodeElevationTile(elevImg) : null;

      if (epoch !== this._loadEpoch) return; // recentered meanwhile

      const geometry = new THREE.PlaneGeometry(1, 1, FAR_GRID, FAR_GRID);
      const position = geometry.attributes.position;
      const vertexCount = (FAR_GRID + 1) * (FAR_GRID + 1);
      const colors = new Float32Array(vertexCount * 3);
      const color = new THREE.Color(FAR_BASE_COLOR);
      for (let iy = 0; iy <= FAR_GRID; iy++) {
        for (let ix = 0; ix <= FAR_GRID; ix++) {
          const idx = iy * (FAR_GRID + 1) + ix;
          const u = ix / FAR_GRID;
          const v = iy / FAR_GRID;
          const lon = tileX2lon(tx + u, FAR_ZOOM);
          const lat = tileY2lat(ty + v, FAR_ZOOM);
          const { x, z } = latLonToLocal(lat, lon, this.originLat, this.originLon);
          const y = elevGrid ? sampleHeight(elevGrid, u, v) - this.heightOffset : 0;
          position.setXYZ(idx, x, y + FAR_Y_OFFSET, z);
          colors[idx * 3] = color.r;
          colors[idx * 3 + 1] = color.g;
          colors[idx * 3 + 2] = color.b;
        }
      }
      position.needsUpdate = true;
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.computeVertexNormals();

      // No fog (already the fog colour). Starts transparent and fades in
      // via _updateFarFades.
      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 1,
        fog: false,
        transparent: true,
        opacity: 0,
      });
      // Discard fragments inside the player hole (mesh has no transform, so
      // local x/z are world x/z), add grazing-angle haze, then ground haze.
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uHoleCenter = this.holeUniforms.center;
        shader.uniforms.uHoleRadiusSq = this.holeUniforms.radiusSq;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec2 vHoleXZ;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHoleXZ = position.xz;');
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            '#include <common>\nvarying vec2 vHoleXZ;\nuniform vec2 uHoleCenter;\nuniform float uHoleRadiusSq;'
          )
          .replace(
            '#include <clipping_planes_fragment>',
            '#include <clipping_planes_fragment>\nif (dot(vHoleXZ - uHoleCenter, vHoleXZ - uHoleCenter) < uHoleRadiusSq) discard;'
          )
          // Surfaces seen edge-on (distant plains) get a cool haze tint.
          .replace(
            '#include <opaque_fragment>',
            `
            float facing = abs(dot(normalize(vNormal), normalize(vViewPosition)));
            float haze = 1.0 - facing;
            outgoingLight = mix(outgoingLight, outgoingLight + vec3(0.1, 0.14, 0.2), haze * 0.7);
            #include <opaque_fragment>`
          );
        applyGroundHaze(shader);
      };
      const mesh = new THREE.Mesh(geometry, material);
      mesh.receiveShadow = false;
      mesh.castShadow = false;
      this.scene.add(mesh);

      const bytes = (position.array.length * 2 + vertexCount * 2) * 4 + colors.length * 4;
      this.farChunks.set(key, { mesh, tx, ty, bytes, fadeStart: performance.now() });
      this.farStats.created++;
    } catch (err) {
      console.warn('Far terrain chunk failed to load', tx, ty, err);
    } finally {
      this.farPending.delete(key);
    }
  }

  _unloadFarChunk(key) {
    const chunk = this.farChunks.get(key);
    if (!chunk) return;
    this.scene.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    chunk.mesh.material.dispose();
    this.farChunks.delete(key);
    this.farPendingRemoval.delete(key);
    this.farStats.removed++;
  }

  /** Eases fading far chunks to opaque over FAR_FADE_IN_MS; runs every frame. */
  _updateFarFades() {
    if (!this.farChunks.size) return;
    const now = performance.now();
    for (const chunk of this.farChunks.values()) {
      if (chunk.fadeStart == null) continue;
      const t = Math.min(1, (now - chunk.fadeStart) / FAR_FADE_IN_MS);
      chunk.mesh.material.opacity = t;
      if (t >= 1) chunk.fadeStart = null;
    }
  }

  /** Toggles debug tile lines on current and future chunks. */
  setBordersVisible(visible) {
    this.bordersVisible = visible;
    for (const chunk of this.chunks.values()) {
      chunk.border.visible = visible;
      chunk.grid.visible = visible;
    }
  }

  /**
   * Streams both tiers around (localX, localZ). awaitAll blocks until the
   * HIGH/MEDIUM footprint is loaded (LOW and far are fire-and-forget).
   * `heading` {x, z} (unnormalized) prioritizes LOW tiles ahead.
   */
  async update(localX, localZ, awaitAll = false, heading = null) {
    // Every frame, even when the centre tile is unchanged:
    this._updateFarFades();
    this._updateChunkFades();
    if (heading) {
      this._headingX = heading.x;
      this._headingZ = heading.z;
    }
    this.holeUniforms.center.value.set(localX, localZ);

    const { lat, lon } = localToLatLon(localX, localZ, this.originLat, this.originLon);

    const centerX = Math.floor(lon2tileX(lon, DETAIL_ZOOM));
    const centerY = Math.floor(lat2tileY(lat, DETAIL_ZOOM));
    this._centerX = centerX;
    this._centerY = centerY;

    const farCenterX = Math.floor(lon2tileX(lon, FAR_ZOOM));
    const farCenterY = Math.floor(lat2tileY(lat, FAR_ZOOM));
    this._farCenterX = farCenterX;
    this._farCenterY = farCenterY;

    const key = `${centerX}_${centerY}`;
    const farKey = `${farCenterX}_${farCenterY}`;
    const centerUnchanged = this._lastCenter === key && this._lastFarCenter === farKey;
    if (!awaitAll && centerUnchanged) return;
    this._lastCenter = key;
    this._lastFarCenter = farKey;

    const wanted = [];
    for (const { dx, dy } of circleOffsets(LOW_DETAIL_RADIUS)) {
      const promise = this._enqueueLoad(centerX + dx, centerY + dy);
      if (inCircle(dx, dy, DETAIL_RADIUS)) wanted.push(promise);
    }
    for (const { dx, dy } of circleOffsets(this.farRadiusTiles)) {
      this._loadFarChunk(farCenterX + dx, farCenterY + dy);
    }
    if (awaitAll) await Promise.all(wanted);

    // Stage out-of-range chunks for delayed removal; rescue returning ones.
    const keepRadius = LOW_DETAIL_RADIUS + UNLOAD_MARGIN;
    for (const [k, chunk] of this.chunks) {
      const farAway = !inCircle(chunk.tx - centerX, chunk.ty - centerY, keepRadius);
      if (farAway) {
        if (!this.pendingRemoval.has(k)) this.pendingRemoval.set(k, UNLOAD_DELAY_TICKS);
      } else {
        this.pendingRemoval.delete(k);
      }

      // Crossing MEDIUM<->LOW changes mesh density and physics presence,
      // so rebuild (via the queue); HIGH<->MEDIUM is just a relabel.
      const newLevel = detailLevelForOffset(chunk.tx - centerX, chunk.ty - centerY);
      if ((newLevel === DetailLevel.LOW) !== (chunk.level === DetailLevel.LOW) && !farAway) {
        this._enqueueRebuild(chunk.tx, chunk.ty);
        continue;
      }
      chunk.level = newLevel;
    }

    // Drop queued (not rebuild) entries that drifted out of range meanwhile.
    if (this._loadQueue.length) {
      this._loadQueue = this._loadQueue.filter((entry) => {
        if (entry.rebuild) return true;
        const stillWanted = inCircle(entry.tx - centerX, entry.ty - centerY, keepRadius);
        if (!stillWanted) this._resolveQueueWaiters(entry.key);
        return stillWanted;
      });
    }

    for (const [k, ticksLeft] of this.pendingRemoval) {
      if (ticksLeft <= 1) {
        this._unloadChunk(k); // also clears it from pendingRemoval
      } else {
        this.pendingRemoval.set(k, ticksLeft - 1);
      }
    }

    const farKeepRadius = this.farRadiusTiles + FAR_UNLOAD_MARGIN;
    for (const [k, chunk] of this.farChunks) {
      const farAway = !inCircle(chunk.tx - farCenterX, chunk.ty - farCenterY, farKeepRadius);
      if (farAway) {
        if (!this.farPendingRemoval.has(k)) this.farPendingRemoval.set(k, FAR_UNLOAD_DELAY_TICKS);
      } else {
        this.farPendingRemoval.delete(k);
      }
    }
    for (const [k, ticksLeft] of this.farPendingRemoval) {
      if (ticksLeft <= 1) {
        this._unloadFarChunk(k);
      } else {
        this.farPendingRemoval.set(k, ticksLeft - 1);
      }
    }
  }

  /**
   * Debug HUD snapshot: counts, memory estimate, and a grid of detail tiles
   * (loaded/pending/removing/empty + level) around the player. The grid
   * grows to include tracked tiles up to maxStrayRadius; farther ones are
   * only counted as `stray`. Far tier is reported as totals only.
   */
  getStats() {
    let memoryBytes = 0;
    for (const chunk of this.chunks.values()) memoryBytes += chunk.bytes || 0;
    let farMemoryBytes = 0;
    for (const chunk of this.farChunks.values()) farMemoryBytes += chunk.bytes || 0;

    // "Pending" = in flight or still queued.
    const pendingKeys = new Set([...this.pending, ...this._queueWaiters.keys()]);

    const keepRadius = LOW_DETAIL_RADIUS + UNLOAD_MARGIN;
    const maxStrayRadius = keepRadius + 5; // keeps the HUD grid bounded
    let minDx = -keepRadius;
    let maxDx = keepRadius;
    let minDy = -keepRadius;
    let maxDy = keepRadius;
    let stray = 0;
    const allKeys = new Set([...this.chunks.keys(), ...pendingKeys, ...this.pendingRemoval.keys()]);
    for (const k of allKeys) {
      const [tx, ty] = k.split('_').map(Number);
      const dx = tx - this._centerX;
      const dy = ty - this._centerY;
      if (Math.abs(dx) > maxStrayRadius || Math.abs(dy) > maxStrayRadius) {
        stray++;
        continue;
      }
      if (dx < minDx) minDx = dx;
      if (dx > maxDx) maxDx = dx;
      if (dy < minDy) minDy = dy;
      if (dy > maxDy) maxDy = dy;
    }

    const grid = [];
    for (let dy = minDy; dy <= maxDy; dy++) {
      const row = [];
      for (let dx = minDx; dx <= maxDx; dx++) {
        const tx = this._centerX + dx;
        const ty = this._centerY + dy;
        const k = this._key(tx, ty);
        let state = 'empty';
        if (this.pendingRemoval.has(k)) state = 'removing';
        else if (this.chunks.has(k)) state = 'loaded';
        else if (pendingKeys.has(k)) state = 'pending';
        row.push({ tx, ty, state: dx === 0 && dy === 0 ? 'player' : state, level: detailLevelForOffset(dx, dy) });
      }
      grid.push(row);
    }

    return {
      loaded: this.chunks.size,
      pending: pendingKeys.size,
      pendingRemoval: this.pendingRemoval.size,
      created: this.stats.created,
      removed: this.stats.removed,
      memoryBytes,
      center: { tx: this._centerX, ty: this._centerY },
      radius: keepRadius,
      gridCenter: { row: -minDy, col: -minDx }, // player's cell (shifts if grid grew asymmetrically)
      grid,
      stray, // tracked tiles beyond maxStrayRadius, not drawn
      far: {
        loaded: this.farChunks.size,
        pending: this.farPending.size,
        pendingRemoval: this.farPendingRemoval.size,
        created: this.farStats.created,
        removed: this.farStats.removed,
        memoryBytes: farMemoryBytes,
      },
    };
  }
}
