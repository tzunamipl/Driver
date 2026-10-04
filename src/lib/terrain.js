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

// Free, no-API-key worldwide aerial imagery. Exported so other consumers
// (e.g. the minimap HUD) can pull the same tile source without duplicating
// the URL scheme.
export const AERIAL_URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

// Elevation: AWS Terrarium tiles (Mapzen's open elevation dataset, mirrored
// as a public S3 bucket by the Registry of Open Data on AWS). Free, no API
// key/rate limit. Must be requested via the *virtual-hosted-style* bucket
// URL (`<bucket>.s3.amazonaws.com/...`) rather than the path-style URL
// (`s3.amazonaws.com/<bucket>/...`) - only the former actually returns
// `Access-Control-Allow-Origin` on GET responses (verified directly; the
// path-style URL returns 200 but with no CORS headers at all, which taints
// the canvas and breaks getImageData()).
const ELEVATION_URL = (z, x, y) =>
  `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;

// ---------------------------------------------------------------------------
// Two-tier level of detail:
//   - "detail" tier: full-res aerial imagery + mesh + physics collision, kept
//     loaded in a small circular radius around the player (~2 tiles).
//   - "far" tier: a much coarser, texture-less backdrop (elevation-only,
//     vertex-colored, no physics) that extends the visible horizon out to
//     FAR_RADIUS_METERS so the world doesn't visibly end a few km out.
// Both tiers select tiles in a circle (not a square) around the player, and
// stage removals a few ticks before actually unloading to avoid thrashing.
// ---------------------------------------------------------------------------

// DETAIL_ZOOM/DETAIL_RADIUS/UNLOAD_MARGIN/UNLOAD_DELAY_TICKS/circleOffsets/
// inCircle are exported (below their definitions) so other streamed-content
// managers (e.g. BuildingsManager) can align their own tile grid exactly
// with the detail tier's footprint instead of duplicating these constants.
export const DETAIL_ZOOM = 15; // ~600-800m tiles at mid latitudes; safe worldwide coverage for both sources
const DETAIL_GRID = 16; // heightmap/mesh resolution per tile edge (GRID+1 vertices)
export const DETAIL_RADIUS = 2; // circular load radius (in tiles) for the fully-detailed tier
export const UNLOAD_MARGIN = 1; // extra tiles of slack before unloading, to avoid load/unload thrashing

// ---------------------------------------------------------------------------
// Sub-tier detail level: *within* the detail tier's loaded footprint above,
// each tile is additionally tagged HIGH/MEDIUM/LOW so extra-expensive
// content (currently streets.js/rivers.js's debug overlays) only has to be
// fetched/rendered for the handful of tiles immediately around the player,
// not the whole detail tier:
//   - HIGH: the 3x3 block of tiles centered on the player's current tile
//     (the player's own tile plus its 8 neighbors).
//   - MEDIUM: every other tile currently loaded within DETAIL_RADIUS (i.e.
//     the same footprint buildings.js/vectorPolygonLayer.js/
//     vectorLineLayer.js key their own loading off today).
//   - LOW: an extra outer ring, out to LOW_DETAIL_RADIUS, loaded *only* by
//     this file's TerrainManager (terrain mesh + aerial texture) - every
//     other DETAIL_RADIUS-aligned streamer (buildings/streets/rivers/water
//     overlays) is intentionally unaffected and keeps ignoring tiles out
//     here, same as it always has.
// Exported (with the color ramp below) so streets.js/rivers.js can mirror
// the HIGH-only footprint instead of duplicating this radius, and so
// debugVisuals/terrain border coloring stay in sync with whatever actually
// gets the extra detail.
// ---------------------------------------------------------------------------
export const HIGH_DETAIL_RADIUS = 1; // tiles (square, i.e. the 3x3 block) - see above
// Extra terrain-only ring beyond MEDIUM's DETAIL_RADIUS footprint. Kept as
// its own constant (rather than growing DETAIL_RADIUS itself) so every
// other DETAIL_RADIUS-aligned system keeps its existing footprint exactly
// as-is - see doc comment above.
export const LOW_DETAIL_RADIUS = DETAIL_RADIUS + 15;
// LOW tiles render at 1/16th of the normal mesh's vertex/triangle count.
// A PlaneGeometry's vertex count is (grid+1)^2, which scales with grid^2
// for grid >> 1, so quartering the per-edge subdivision count (1/4^2 =
// 1/16 the area) cuts the total vertex/triangle count to 1/16th.
const LOW_DETAIL_GRID = Math.max(1, Math.round(DETAIL_GRID / 4));
export const DetailLevel = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' };

/** Classifies a tile offset (dx, dy from the current center tile) into a DetailLevel - see the doc comment above. */
export function detailLevelForOffset(dx, dy) {
  if (Math.abs(dx) <= HIGH_DETAIL_RADIUS && Math.abs(dy) <= HIGH_DETAIL_RADIUS) return DetailLevel.HIGH;
  if (inCircle(dx, dy, DETAIL_RADIUS)) return DetailLevel.MEDIUM;
  return DetailLevel.LOW;
}

// Tile detail-level color ramp - a bright/medium/desaturated green ramp so
// a tile's current detail level reads at a glance. Not used for the 3D
// scene's tile borders (those stay a plain yellow, see borderMaterial
// below) - instead consumed by the debug stats HUD's tile grid
// (terrainStatsHud.js) via getStats()'s per-cell `level` field.
export const DETAIL_LEVEL_COLORS = {
  [DetailLevel.HIGH]: 0x39ff14, // bright green
  [DetailLevel.MEDIUM]: 0x2e8b22, // medium green
  [DetailLevel.LOW]: 0x6f8f6a, // desaturated green/"green-grey"
};


// A tile is "in" a circular radius R if dx^2+dy^2 <= (R + CIRCLE_SLACK)^2.
// The slack rounds the selection out a bit past a mathematically strict
// circle so the shape doesn't look overly sparse/spiky at small radii, while
// still culling the square's far corners (the whole point of going circular).
const CIRCLE_SLACK = 0.5;

// Chunks that fall outside the keep radius aren't unloaded immediately -
// they're staged for a few update() ticks first (see `pendingRemoval`).
// This absorbs brief in/out flicker at the radius boundary and gives the
// stats/debug map below a real "planned to be removed" state to display,
// instead of tiles disappearing in the same tick they're flagged.
export const UNLOAD_DELAY_TICKS = 3;

// Far/low-detail tier: no aerial imagery fetch (would be blurry at this zoom
// anyway and multiplies request count), no physics body (the player is
// always within the detail tier's footprint, so far chunks are never driven
// on), and a much coarser mesh. Zoom is deliberately low so covering
// FAR_RADIUS_METERS only needs a few dozen chunks instead of thousands.
const FAR_ZOOM = 11; // ~body of tile is tens of km across at mid latitudes
const FAR_GRID = 11; // low mesh resolution per tile edge - it's a distant backdrop
export const FAR_RADIUS_METERS = 120_000; // how far out the low-detail terrain extends
const FAR_UNLOAD_MARGIN = 1; // tiles of slack, same purpose as UNLOAD_MARGIN above
const FAR_UNLOAD_DELAY_TICKS = 3;
// Nudge the far mesh slightly below the detail tier so where their footprints
// briefly overlap at the LOD boundary, the coarse mesh loses any z-fight/
// peek-through against the detailed one instead of flickering on top of it.
const FAR_Y_OFFSET = -3;

// Imagery is fetched at a higher zoom than the elevation/mesh grid and stitched
// into a mosaic texture, since aerial detail is available at much finer zoom
// than terrain-rgb (which is effectively flat past ~15) and imagery resolution
// is what makes the ground look sharp up close.
const AERIAL_ZOOM_BOOST = 2; // 2 levels = 4x4 child tiles = 1024x1024 texture per chunk
const AERIAL_TILE_SIZE = 256;

// Dedicated collision group for terrain bodies so other code (e.g. the
// anti-tunneling ground raycast in main.js) can raycast against only the
// ground, ignoring the car's own chassis/wheel shapes.
export const GROUND_COLLISION_GROUP = 2;
// Shared so the ball can register a bouncy contact without changing how
// the chassis meets the ground (that pair still uses the world default).
export const GROUND_MATERIAL = new CANNON.Material('ground');

const _groundRayFrom = new CANNON.Vec3();
const _groundRayTo = new CANNON.Vec3();
const _groundRayResult = new CANNON.RaycastResult();
// Tall enough to find the terrain surface under/over a body regardless of
// how far it's ended up from it (e.g. a car that's somehow sunk well
// underground - see lib/car.js's reset(), which anchors its lift target to
// this instead of a fixed offset from the car's own, possibly-underground,
// current position).
export const GROUND_SEARCH_HEIGHT = 5000;

/**
 * Finds the terrain surface's y at a given (x, z) by casting a tall ray
 * straight down through that whole column - independent of any particular
 * body's current position, so it works even when that body has ended up
 * far below (or above) the real surface. Returns null if no terrain chunk
 * is loaded there yet (e.g. a spot this player's TerrainManager hasn't
 * streamed in).
 */
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
 * Builds a single high-resolution texture for one (z, x, y) chunk by fetching
 * a grid of child tiles at z + zoomBoost and stitching them into one canvas.
 * Individual child tile failures (e.g. no coverage at that zoom in a given
 * area) are left blank rather than failing the whole chunk. `zoomBoost`
 * defaults to AERIAL_ZOOM_BOOST (the normal HIGH/MEDIUM mosaic); LOW tiles
 * pass 0 instead (see _loadChunk) for a single native-resolution tile - both
 * a 16x cheaper fetch (1 request instead of 16) and a lower-res bitmap to
 * match their coarser mesh.
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

/**
 * Rough estimate of the GPU/CPU memory a loaded chunk holds onto: the aerial
 * texture's decoded RGBA pixels, the mesh's position/normal/uv vertex
 * buffers, its index buffer, and the physics Trimesh's own copies of the
 * vertex/index data. Not exact (driver/GPU overhead varies), but good enough
 * for a "is this leaking?" memory readout.
 */
function estimateChunkBytes(textureImage, positions, indices, hasPhysics = true) {
  const texBytes = (textureImage.width || 0) * (textureImage.height || 0) * 4;
  const vertexCount = positions.length / 3;
  // position + normal (3 floats each) + uv (2 floats), 4 bytes/float, x2 for
  // the Trimesh's own copy of vertices/indices in CANNON - only applies
  // when a physics body actually exists (LOW tiles skip it, see
  // _loadChunk).
  const physicsFactor = hasPhysics ? 2 : 1;
  const meshBytes = (positions.length * physicsFactor + vertexCount * 2) * 4;
  const indexBytes = indices.length * 4 * physicsFactor;
  return texBytes + meshBytes + indexBytes;
}

// Tiny lift applied to the boundary/grid lines along each vertex's normal,
// so the lines sit just above the terrain surface instead of z-fighting
// with it (a flat Y offset would float off the surface on steep slopes).
// The grid uses a slightly smaller lift than the border so the (bolder,
// brighter) perimeter line always renders on top where the two would
// otherwise coincide (e.g. along a tile's own edge).
const BORDER_LIFT = 0.15;
const GRID_LIFT = 0.1;
const BORDER_COLOR = 0xffe14d;
const GRID_COLOR = 0xffe14d;

// Regular THREE.Line(Basic)Material's `linewidth` is silently ignored by
// almost every platform's WebGL backend (ANGLE/ES only exposes 1px lines
// regardless of what's requested), so both the tile border and the tile
// geometry (polygon) lines below use the "fat lines" addon instead
// (LineSegments2/LineSegmentsGeometry/LineMaterial), which fakes width by
// expanding each segment into a screen-space-aligned quad. That requires a
// `resolution` uniform tracking the viewport in CSS pixels, kept in sync
// here via a dedicated resize listener rather than plumbing the renderer
// size through from main.js/sceneSetup.js.
const BORDER_LINEWIDTH = 3; // px - bold outline around each tile
const GRID_LINEWIDTH = 1.25; // px - subtle mesh/polygon lines within a tile
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

/**
 * Builds a closed loop of fat line segments tracing the outer edge of a
 * tile's displaced plane geometry, so adjacent chunks are visually
 * distinguishable in the 3D view. Walks the perimeter vertices (already
 * elevation-displaced) in order and nudges each one up along its vertex
 * normal.
 */
function buildTileBorder(geometry, grid) {
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const perimeter = [];
  for (let ix = 0; ix <= grid; ix++) perimeter.push(ix); // top edge, iy = 0, left -> right
  for (let iy = 1; iy <= grid; iy++) perimeter.push(iy * (grid + 1) + grid); // right edge, top -> bottom
  for (let ix = grid - 1; ix >= 0; ix--) perimeter.push(grid * (grid + 1) + ix); // bottom edge, right -> left
  for (let iy = grid - 1; iy >= 1; iy--) perimeter.push(iy * (grid + 1)); // left edge, bottom -> top

  // Fat-line segments are independent (start,end) pairs rather than a
  // connected strip, so each consecutive perimeter vertex pair (wrapping
  // back to the first) becomes its own segment.
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

/**
 * Builds fat line segments tracing every triangle edge of a tile's
 * displaced plane geometry (its actual render polygons), so the mesh
 * density/shape is visible in the 3D view alongside the bolder perimeter
 * border. Each shared edge between two triangles is only emitted once.
 */
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

/**
 * List of (dx, dy) tile offsets within `radius` tiles of the origin,
 * shaped like a circle rather than a square (see inCircle), sorted nearest
 * first so closer tiles are requested/populated ahead of far ones.
 */
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

// Coarse elevation -> color ramp used for the far/low-detail tier, standing
// in for aerial imagery (which isn't fetched at that tier). Purely
// stylistic: lowland green -> hill brown -> rock grey -> snow cap, all
// pushed toward blue to read as a hazy, atmosphere-tinted backdrop rather
// than competing for attention with the full-color detail tier up close.
const FAR_COLOR_STOPS = [
  { y: 300, r: 0.22, g: 0.38, b: 0.42 },
  { y: 900, r: 0.3, g: 0.36, b: 0.48 },
  { y: 1600, r: 0.42, g: 0.47, b: 0.58 },
  { y: Infinity, r: 0.82, g: 0.86, b: 0.97 },
];
function farElevationColor(y, out) {
  const stop = FAR_COLOR_STOPS.find((s) => y < s.y) || FAR_COLOR_STOPS[FAR_COLOR_STOPS.length - 1];
  out.setRGB(stop.r, stop.g, stop.b);
}

// Lowland stop of the ramp above, exposed as a flat hex color for things
// that need a single representative "low-detail background" tone (e.g.
// scene fog) rather than the full elevation-dependent gradient - most
// driving happens near this elevation band, so it's the best single match.
export const FAR_BASE_COLOR = new THREE.Color(
  FAR_COLOR_STOPS[0].r,
  FAR_COLOR_STOPS[0].g,
  FAR_COLOR_STOPS[0].b
).getHex();

/**
 * Streams real-world terrain (aerial imagery + elevation) as circularly-
 * selected chunks aligned to Web Mercator map tiles, loading/unloading
 * around a moving player position, at two tiers (each internally split
 * further by DetailLevel, see above):
 *
 *  - "detail" tier: aerial-textured mesh kept loaded out to
 *    LOW_DETAIL_RADIUS tiles of the player. The inner DETAIL_RADIUS tiles
 *    (HIGH/MEDIUM) get a full-res mesh plus a matching Cannon-es Trimesh
 *    physics body (built from the exact same vertices, so visuals and
 *    collision are always perfectly aligned); the extra outer LOW ring
 *    gets a quarter-density mesh and no physics body (see _loadChunk).
 *  - "far" tier: a coarse, texture-less, physics-less backdrop extending
 *    the visible horizon out to FAR_RADIUS_METERS.
 */
export class TerrainManager {
  constructor(scene, world, originLat, originLon) {
    this.scene = scene;
    this.world = world;
    this.originLat = originLat;
    this.originLon = originLon;
    this.chunks = new Map(); // key -> { mesh, body, border, grid, tx, ty, bytes }
    this.pending = new Set(); // keys currently being fetched (planned to be created)
    this.pendingRemoval = new Map(); // key -> ticks remaining before actual unload
    // Detail-tier chunks are loaded strictly one at a time (never more than
    // one in-flight fetch/mesh-build at once), via a priority queue rather
    // than firing every wanted tile off concurrently - see _enqueueLoad/
    // _pumpQueue. `_loadQueue` holds not-yet-started requests; `_queueWaiters`
    // maps each queued/in-flight key to the resolver(s) for whoever's
    // awaiting that specific tile (update()'s `wanted` list for awaitAll).
    this._loadQueue = []; // [{ tx, ty, key }]
    this._queueWaiters = new Map(); // key -> Array<() => void>
    this._pumping = false; // whether the queue-draining loop is currently running
    this.heightOffset = 0; // subtracted from raw elevation so origin sits near y=0
    this._lastCenter = null;
    this._centerX = 0;
    this._centerY = 0;
    // Lifetime counters for the debug/stats HUD.
    this.stats = { created: 0, removed: 0 };
    // Whether newly-created chunks show their perimeter border by default;
    // toggled at runtime via setBordersVisible().
    this.bordersVisible = true;

    // Far/low-detail tier state, mirroring the detail-tier fields above but
    // tracked separately since the two run on independent tile grids/zooms.
    this.farChunks = new Map(); // key -> { mesh, tx, ty, bytes }
    this.farPending = new Set();
    this.farPendingRemoval = new Map();
    this.farStats = { created: 0, removed: 0 };
    this._lastFarCenter = null;
    this._farCenterX = 0;
    this._farCenterY = 0;
    // How many FAR_ZOOM tiles it takes to reach FAR_RADIUS_METERS at this
    // latitude; computed once since the play area's latitude range is small
    // enough that tile ground-size doesn't meaningfully change.
    this.farRadiusTiles = FAR_RADIUS_METERS / tileSizeMeters(FAR_ZOOM, originLat);

    // Far-tier tiles are tens of km across (far coarser than the ~1-3km the
    // detail tier actually covers), so tile-level exclusion alone can't keep
    // them out from directly under/around the player - the whole huge tile
    // the player stands on would otherwise render right through the
    // detailed mesh. Instead, cut a circular "hole" out of the far tier's
    // fragment shader, centered on the player's current local position and
    // sized just past the detail tier's real-world keep radius, so the two
    // tiers never occupy the same ground at once regardless of far-tile
    // size. Shared uniform objects: every far chunk's material references
    // the same objects, so updating `.value` here updates all of them.
    const holeRadiusMeters = (LOW_DETAIL_RADIUS + UNLOAD_MARGIN + 1) * tileSizeMeters(DETAIL_ZOOM, originLat);
    this.holeUniforms = {
      center: { value: new THREE.Vector2(0, 0) },
      radiusSq: { value: holeRadiusMeters * holeRadiusMeters },
    };
  }

  /**
   * Fetches elevation at the origin point and stores it as the height
   * baseline. If even this single request fails (e.g. a transient API/token
   * issue), fall back to a zero baseline rather than leaving the app stuck
   * on the loading screen forever - the world will just be offset from its
   * "true" elevation rather than unusable.
   */
  async init() {
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
    await this.update(0, 0, true);
  }

  _key(tx, ty) {
    return `${tx}_${ty}`;
  }

  /** True once a tile's terrain mesh/physics have actually been built - used by the debug stats HUD's per-tile progress indicator. */
  isTileLoaded(tx, ty) {
    return this.chunks.has(this._key(tx, ty));
  }

  /**
   * Re-centers the whole terrain system on a new lat/lon origin - used to
   * "teleport" the car to an arbitrary searched address. The local flat-
   * meters projection (see geo.js) is only accurate near its origin, so
   * jumping far away isn't done by just moving the car in the old local
   * space; instead every current chunk (detail + far tiers) is torn down
   * and a fresh set is streamed in around (0, 0) local coordinates at the
   * new origin, exactly like the initial `init()` call. Resolves once the
   * new origin's initial chunk batch has loaded.
   */
  async recenter(lat, lon) {
    for (const key of Array.from(this.chunks.keys())) this._unloadChunk(key);
    for (const key of Array.from(this.farChunks.keys())) this._unloadFarChunk(key);
    this.pending.clear();
    this.pendingRemoval.clear();
    this.farPending.clear();
    this.farPendingRemoval.clear();
    // Drop the old origin's load queue entirely (its tile coordinates are
    // meaningless at the new origin) but resolve any outstanding waiters
    // first so a previous update()'s awaitAll Promise.all never hangs.
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
    const holeRadiusMeters = (LOW_DETAIL_RADIUS + UNLOAD_MARGIN + 1) * tileSizeMeters(DETAIL_ZOOM, lat);
    this.holeUniforms.radiusSq.value = holeRadiusMeters * holeRadiusMeters;

    await this.init();
  }

  /** Lower is more urgent: HIGH tiles always jump ahead of MEDIUM/LOW ones, regardless of how long those have been queued. */
  _queuePriorityRank(tx, ty) {
    const level = detailLevelForOffset(tx - this._centerX, ty - this._centerY);
    if (level === DetailLevel.HIGH) return 0;
    if (level === DetailLevel.MEDIUM) return 1;
    return 2; // LOW
  }

  /**
   * Requests that (tx, ty) be loaded, enforcing a single in-flight load at
   * a time across the whole detail tier (see _pumpQueue) instead of firing
   * every wanted tile's fetch off concurrently. Returns a promise that
   * resolves once that specific tile is loaded (already-loaded tiles
   * resolve immediately). Safe to call repeatedly for the same tile every
   * update() tick - a tile already queued/loaded is never queued twice.
   */
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
   * Drains _loadQueue strictly one tile at a time - never starts a second
   * _loadChunk before the previous one has fully finished (fetch + mesh/
   * physics build) - picking, on every iteration, the queued tile with the
   * best current priority (see _queuePriorityRank) and, among ties, the
   * one nearest the player (so a HIGH tile queued just now still jumps
   * ahead of a MEDIUM/LOW tile that's been waiting far longer, and the
   * player's own center tile - distance 0, always HIGH - loads first).
   * Priority is recomputed on every pick rather than frozen at enqueue
   * time, so a tile's urgency stays current even if the player moves while
   * it's still waiting in line. Re-entrant calls while already draining
   * are no-ops - only one drain loop ever runs.
   */
  async _pumpQueue() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      let next;
      while ((next = this._dequeueNext())) {
        const { tx, ty, key } = next;
        // Note: _queueWaiters[key] is deliberately *not* cleared yet here -
        // it stays registered for the whole fetch/build below, so a tile
        // that's already in-flight (removed from _loadQueue, i.e. no
        // longer "waiting in line", but not finished loading yet) is
        // recognized by _enqueueLoad and attaches its new caller to the
        // same waiter list instead of pushing a duplicate queue entry for
        // a tile that's already being worked on.
        if (this.chunks.has(key) || !inCircle(tx - this._centerX, ty - this._centerY, LOW_DETAIL_RADIUS)) {
          this._resolveQueueWaiters(key);
          continue;
        }
        await this._loadChunk(tx, ty);
        this._resolveQueueWaiters(key);
      }
    } finally {
      this._pumping = false;
    }
  }

  /** Resolves and clears every caller currently waiting on `key` via _enqueueLoad. */
  _resolveQueueWaiters(key) {
    const waiters = this._queueWaiters.get(key);
    this._queueWaiters.delete(key);
    waiters?.forEach((resolve) => resolve());
  }

  /** Removes and returns the highest-priority (lowest rank, then nearest) entry from _loadQueue, or null if empty. */
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

  async _loadChunk(tx, ty) {
    const key = this._key(tx, ty);
    if (this.chunks.has(key) || this.pending.has(key)) return;
    this.pending.add(key);
    try {
      // LOW tiles (the outer ring beyond MEDIUM's DETAIL_RADIUS footprint,
      // see DetailLevel doc comment) get a quarter-density mesh and skip
      // the physics body entirely - the player is never expected to
      // actually drive this far out, so a Trimesh body out here would just
      // be wasted CPU/memory.
      const level = detailLevelForOffset(tx - this._centerX, ty - this._centerY);
      const gridRes = level === DetailLevel.LOW ? LOW_DETAIL_GRID : DETAIL_GRID;
      // LOW also gets a much lower-res aerial bitmap - a single native
      // tile (zoomBoost 0) instead of the normal 4x4 mosaic - to match its
      // coarser mesh and cut its fetch cost 16x (1 request instead of 16).
      const aerialZoomBoost = level === DetailLevel.LOW ? 0 : undefined;

      // Elevation failures (e.g. a rejected/rate-limited API request) are
      // tolerated with a flat fallback rather than dropping the whole
      // chunk - a flat patch of ground is much safer than a hole the car
      // could physically fall through, and it self-heals next time the
      // chunk streams back in range and the fetch happens to succeed.
      const [colorTex, elevImg] = await Promise.all([
        loadAerialTexture(DETAIL_ZOOM, tx, ty, aerialZoomBoost),
        loadImage(ELEVATION_URL(DETAIL_ZOOM, tx, ty)).catch((err) => {
          console.warn('Detail chunk elevation fetch failed, using flat fallback', tx, ty, err);
          return null;
        }),
      ]);
      const elevGrid = elevImg ? decodeElevationTile(elevImg) : null;

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
      const mesh = new THREE.Mesh(geometry, material);
      mesh.receiveShadow = true;
      this.scene.add(mesh);

      // Visual boundary: a bold line loop traced around the tile's
      // perimeter so adjacent chunks are distinguishable at a glance in the
      // 3D view, plus fainter/thinner lines along every triangle edge of
      // the tile's actual render geometry (its polygons). Both are part of
      // the debug visuals, so they respect the current toggle state.
      const border = buildTileBorder(geometry, gridRes);
      border.visible = this.bordersVisible;
      this.scene.add(border);
      const grid = buildTileGrid(geometry);
      grid.visible = this.bordersVisible;
      this.scene.add(grid);

      // Physics: Trimesh built from the exact same vertices/indices as the
      // visual mesh (both live in world space, body at identity transform),
      // so collision can never drift out of alignment with what's rendered.
      // Skipped for LOW tiles - see comment above.
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

      this.chunks.set(key, { mesh, body, border, grid, tx, ty, bytes, level });
      this.stats.created++;
    } catch (err) {
      console.warn('Terrain chunk failed to load', tx, ty, err);
    } finally {
      this.pending.delete(key);
    }
  }

  _unloadChunk(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.scene.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    chunk.mesh.material.map?.dispose();
    chunk.mesh.material.dispose();
    this.scene.remove(chunk.border);
    chunk.border.geometry.dispose();
    this.scene.remove(chunk.grid);
    chunk.grid.geometry.dispose();
    // Note: border/grid materials are shared LineMaterial instances (see
    // module scope above) so they're intentionally never disposed here.
    // chunk.body is null for LOW tiles (see _loadChunk) - no physics to tear down.
    if (chunk.body) this.world.removeBody(chunk.body);
    this.chunks.delete(key);
    this.pendingRemoval.delete(key);
    this.stats.removed++;
  }

  /**
   * Loads one far/low-detail chunk: elevation only (no aerial imagery
   * fetch), a coarse displaced-plane mesh with elevation-ramp vertex
   * colors, and no physics body - this tier is purely a distant backdrop.
   * An elevation fetch failure falls back to a flat patch (y=0) instead of
   * dropping the chunk entirely, so a rejected/rate-limited tile just
   * leaves a flat-looking patch of horizon rather than a visible gap.
   */
  async _loadFarChunk(tx, ty) {
    const key = this._key(tx, ty);
    if (this.farChunks.has(key) || this.farPending.has(key)) return;
    this.farPending.add(key);
    try {
      const elevImg = await loadImage(ELEVATION_URL(FAR_ZOOM, tx, ty)).catch((err) => {
        console.warn('Far chunk elevation fetch failed, using flat fallback', tx, ty, err);
        return null;
      });
      const elevGrid = elevImg ? decodeElevationTile(elevImg) : null;

      const geometry = new THREE.PlaneGeometry(1, 1, FAR_GRID, FAR_GRID);
      const position = geometry.attributes.position;
      const vertexCount = (FAR_GRID + 1) * (FAR_GRID + 1);
      const colors = new Float32Array(vertexCount * 3);
      const color = new THREE.Color();
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
          farElevationColor(y, color);
          colors[idx * 3] = color.r;
          colors[idx * 3 + 1] = color.g;
          colors[idx * 3 + 2] = color.b;
        }
      }
      position.needsUpdate = true;
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.computeVertexNormals();

      // fog: false - the FAR backdrop tier is excluded from scene.fog so
      // it keeps its own elevation-based color ramp (FAR_COLOR_STOPS,
      // already hand-tuned to read as a hazy atmosphere-tinted horizon)
      // all the way out, instead of being flattened into the fog color by
      // the 20km far-distance that's meant to target the LOW detail tier.
      const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, fog: false });
      // Punch the player-centered hole (see holeUniforms comment above) by
      // discarding fragments within holeRadius of the player's local x/z.
      // Vertex local x/z double as world x/z here since far-tier meshes are
      // added to the scene with no transform.
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
          // Grazing-angle haze: faces whose normal sits closer to perpendicular
          // to the view direction (i.e. the surface itself is closer to
          // parallel with the view - a distant plain stretching toward the
          // horizon) get brightened with a cool blue tint, mimicking
          // atmospheric haze; faces pointed straight at the camera stay at
          // their base color. `vNormal`/`vViewPosition` are varyings the
          // standard material shader already provides, so this is just one
          // extra dot product and a mix per fragment - free on top of the
          // existing per-pixel lighting, and this mesh is low-poly to begin
          // with (FAR_GRID is coarse).
          .replace(
            '#include <opaque_fragment>',
            `
            float facing = abs(dot(normalize(vNormal), normalize(vViewPosition)));
            float haze = 1.0 - facing;
            outgoingLight = mix(outgoingLight, outgoingLight + vec3(0.1, 0.14, 0.2), haze * 0.7);
            #include <opaque_fragment>`
          );
      };
      const mesh = new THREE.Mesh(geometry, material);
      mesh.receiveShadow = false;
      mesh.castShadow = false;
      this.scene.add(mesh);

      const bytes = (position.array.length * 2 + vertexCount * 2) * 4 + colors.length * 4;
      this.farChunks.set(key, { mesh, tx, ty, bytes });
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

  /**
   * Toggles the perimeter border lines and per-polygon geometry lines on
   * all currently-loaded chunks (and future ones).
   */
  setBordersVisible(visible) {
    this.bordersVisible = visible;
    for (const chunk of this.chunks.values()) {
      chunk.border.visible = visible;
      chunk.grid.visible = visible;
    }
  }

  /**
   * Ensures chunks around (localX, localZ) are loaded, and unloads chunks
   * that have fallen far enough outside the load radius. Both the detail
   * and far tiers are driven from the same call, each on its own tile grid.
   * Pass `await` (via awaitAll=true) to block until the initial detail-tier
   * batch is ready - the far tier is always fire-and-forget (see below) so
   * its many more tiles never delay spawning.
   */
  async update(localX, localZ, awaitAll = false) {
    // Keep the far-tier hole centered on the player every call, even when
    // the tile grid below hasn't changed - otherwise the hole would only
    // move in DETAIL_ZOOM-tile-sized jumps instead of tracking smoothly.
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
      // Only the MEDIUM/HIGH footprint (DETAIL_RADIUS) is worth blocking
      // spawn on - the extra LOW ring beyond it is a coarse, physics-less
      // backdrop extension (see DetailLevel doc comment above), so like the
      // far tier below it streams in fire-and-forget instead.
      if (inCircle(dx, dy, DETAIL_RADIUS)) wanted.push(promise);
    }
    // Far-tier chunks are a distant, non-collidable backdrop - never worth
    // blocking spawn on. Kick them off without joining `wanted`/awaitAll so
    // the (potentially dozens of) far tiles stream in after the detail tier
    // (and thus after the car can safely spawn) instead of delaying it.
    for (const { dx, dy } of circleOffsets(this.farRadiusTiles)) {
      this._loadFarChunk(farCenterX + dx, farCenterY + dy);
    }
    if (awaitAll) await Promise.all(wanted);

    // Cleanup pass: chunks outside keepRadius are staged into
    // `pendingRemoval` with a tick countdown rather than unloaded on the
    // spot. Anything that drifts back inside the radius before its
    // countdown expires (e.g. the player briefly reverses) is rescued and
    // kept loaded, avoiding pointless reload/unload thrashing at the edge.
    const keepRadius = LOW_DETAIL_RADIUS + UNLOAD_MARGIN;
    for (const [k, chunk] of this.chunks) {
      const farAway = !inCircle(chunk.tx - centerX, chunk.ty - centerY, keepRadius);
      if (farAway) {
        if (!this.pendingRemoval.has(k)) this.pendingRemoval.set(k, UNLOAD_DELAY_TICKS);
      } else {
        this.pendingRemoval.delete(k);
      }

      // The player has just moved to a new center tile (we're past the
      // centerUnchanged early-return above), so every already-loaded
      // tile's HIGH/MEDIUM/LOW detail level may have shifted too. Unlike a
      // HIGH<->MEDIUM shift (just a HUD label change, same mesh either
      // way), crossing the MEDIUM<->LOW boundary means the chunk's actual
      // mesh resolution/physics-body presence are now wrong for its new
      // level (see _loadChunk) - force an immediate rebuild rather than
      // just relabeling, so a tile that just became driveable (LOW ->
      // MEDIUM) doesn't sit there with no collision body under the car.
      const newLevel = detailLevelForOffset(chunk.tx - centerX, chunk.ty - centerY);
      if ((newLevel === DetailLevel.LOW) !== (chunk.level === DetailLevel.LOW) && !farAway) {
        const { tx: chunkTx, ty: chunkTy } = chunk;
        this._unloadChunk(k);
        // Re-request via the same priority queue as everything else (not
        // a direct _loadChunk call) so this rebuild still respects the
        // one-at-a-time/priority-order rule instead of sneaking in an
        // extra concurrent fetch.
        this._enqueueLoad(chunkTx, chunkTy);
        continue;
      }
      chunk.level = newLevel;
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
   * Snapshot of current memory/streaming state for a debug HUD: counts of
   * loaded/pending/staged-for-removal chunks, lifetime created/removed
   * totals, an estimated byte footprint of everything currently loaded, and
   * a "map" grid tagging every detail-tier tile tracked in any state
   * (loaded / pending-create / pending-remove) as loaded / pending /
   * removing / empty, centered on the player. The grid's bounding box is
   * grown (beyond the normal `keepRadius` window) to cover every tracked
   * tile, not just ones near the player - a stray tile loaded somewhere
   * else (e.g. a bug racing a recenter() call - see mainLoop.js) would
   * otherwise silently fall outside a fixed-size window and inflate the
   * loaded/created counts above with no visual trace of where it went.
   * Far-tier totals are reported as aggregate counts only (its footprint
   * is far too large to usefully render as a HUD grid).
   */
  getStats() {
    let memoryBytes = 0;
    for (const chunk of this.chunks.values()) memoryBytes += chunk.bytes || 0;
    let farMemoryBytes = 0;
    for (const chunk of this.farChunks.values()) farMemoryBytes += chunk.bytes || 0;

    // "Pending" for HUD purposes covers both the one tile actually being
    // fetched/built right now (this.pending) and every tile still waiting
    // its turn in the one-at-a-time priority queue (_queueWaiters) - from
    // the HUD's perspective both are just "not loaded yet, but planned".
    const pendingKeys = new Set([...this.pending, ...this._queueWaiters.keys()]);

    const keepRadius = LOW_DETAIL_RADIUS + UNLOAD_MARGIN;
    // Stray tiles (see doc comment above) can in principle land arbitrarily
    // far from the player - e.g. a chunk left behind by a teleport - and
    // widening the grid to always cover them would make the HUD panel grow
    // without bound (observed: a single far-away stray tile blew the grid
    // up to cover the whole screen). Cap how far the *rendered* grid will
    // stretch to accommodate strays; anything further out is still counted
    // (see `stray` below) but shown as a number in the text summary instead
    // of inflating the grid itself.
    const maxStrayRadius = keepRadius + 5;
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
        // `level` (HIGH/MEDIUM/LOW, see DetailLevel above) is reported for
        // every cell regardless of load state, so the HUD can shade a cell
        // by its detail tier as soon as it's loaded (debugVisuals' M-key
        // view) - this is purely a HUD affordance and is unrelated to the
        // 3D scene's tile borders, which stay a plain yellow.
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
      // Grid indices of the player's own (center) cell - usually equal to
      // (-minDy, -minDx), i.e. `radius` from each edge, but can shift if
      // the bounding box above grew asymmetrically to cover a stray tile.
      gridCenter: { row: -minDy, col: -minDx },
      grid,
      // Tiles tracked (loaded/pending/pending-removal) further than
      // `maxStrayRadius` from the player - not drawn in `grid` above (to
      // keep the HUD panel bounded in size), but still worth surfacing as
      // a count so a leftover far-away tile remains visible/diagnosable.
      stray,
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
