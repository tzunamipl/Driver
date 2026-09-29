import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {
  lon2tileX,
  lat2tileY,
  tileX2lon,
  tileY2lat,
  latLonToLocal,
  localToLatLon,
  tileSizeMeters,
} from './geo.js';

// Free, no-API-key worldwide aerial imagery.
const AERIAL_URL = (z, x, y) =>
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
const DETAIL_GRID = 32; // heightmap/mesh resolution per tile edge (GRID+1 vertices)
export const DETAIL_RADIUS = 2; // circular load radius (in tiles) for the fully-detailed tier
export const UNLOAD_MARGIN = 1; // extra tiles of slack before unloading, to avoid load/unload thrashing

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
const FAR_ZOOM = 9; // ~body of tile is tens of km across at mid latitudes
const FAR_GRID = 12; // low mesh resolution per tile edge - it's a distant backdrop
const FAR_RADIUS_METERS = 150_000; // how far out the low-detail terrain extends
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
 * a grid of child tiles at z + AERIAL_ZOOM_BOOST and stitching them into one
 * canvas. Individual child tile failures (e.g. no coverage at that zoom in a
 * given area) are left blank rather than failing the whole chunk.
 */
async function loadAerialTexture(z, x, y) {
  const n = 2 ** AERIAL_ZOOM_BOOST;
  const zz = z + AERIAL_ZOOM_BOOST;
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
function estimateChunkBytes(textureImage, positions, indices) {
  const texBytes = (textureImage.width || 0) * (textureImage.height || 0) * 4;
  const vertexCount = positions.length / 3;
  // position + normal (3 floats each) + uv (2 floats), 4 bytes/float, x2 for
  // the Trimesh's own copy of vertices/indices in CANNON.
  const meshBytes = (positions.length * 2 + vertexCount * 2) * 4;
  const indexBytes = indices.length * 4 * 2;
  return texBytes + meshBytes + indexBytes;
}

// Tiny lift applied to the boundary line along each vertex's normal, so the
// outline sits just above the terrain surface instead of z-fighting with it
// (a flat Y offset would float off the surface on steep slopes).
const BORDER_LIFT = 0.15;
const BORDER_COLOR = 0xffe14d;

/**
 * Builds a closed line loop tracing the outer edge of a tile's displaced
 * plane geometry, so adjacent chunks are visually distinguishable in the
 * 3D view. Walks the perimeter vertices (already elevation-displaced) in
 * order and nudges each one up along its vertex normal.
 */
function buildTileBorder(geometry, grid) {
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const perimeter = [];
  for (let ix = 0; ix <= grid; ix++) perimeter.push(ix); // top edge, iy = 0, left -> right
  for (let iy = 1; iy <= grid; iy++) perimeter.push(iy * (grid + 1) + grid); // right edge, top -> bottom
  for (let ix = grid - 1; ix >= 0; ix--) perimeter.push(grid * (grid + 1) + ix); // bottom edge, right -> left
  for (let iy = grid - 1; iy >= 1; iy--) perimeter.push(iy * (grid + 1)); // left edge, bottom -> top

  const points = new Float32Array(perimeter.length * 3);
  for (let i = 0; i < perimeter.length; i++) {
    const idx = perimeter[i];
    points[i * 3] = position.getX(idx) + normal.getX(idx) * BORDER_LIFT;
    points[i * 3 + 1] = position.getY(idx) + normal.getY(idx) * BORDER_LIFT;
    points[i * 3 + 2] = position.getZ(idx) + normal.getZ(idx) * BORDER_LIFT;
  }

  const borderGeometry = new THREE.BufferGeometry();
  borderGeometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
  const material = new THREE.LineBasicMaterial({
    color: BORDER_COLOR,
    transparent: true,
    opacity: 0.6,
  });
  return new THREE.LineLoop(borderGeometry, material);
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
// stylistic: lowland green -> hill brown -> rock grey -> snow cap.
const FAR_COLOR_STOPS = [
  { y: 300, r: 0.3, g: 0.45, b: 0.2 },
  { y: 900, r: 0.42, g: 0.38, b: 0.28 },
  { y: 1600, r: 0.55, g: 0.55, b: 0.55 },
  { y: Infinity, r: 0.92, g: 0.92, b: 0.95 },
];
function farElevationColor(y, out) {
  const stop = FAR_COLOR_STOPS.find((s) => y < s.y) || FAR_COLOR_STOPS[FAR_COLOR_STOPS.length - 1];
  out.setRGB(stop.r, stop.g, stop.b);
}

/**
 * Streams real-world terrain (aerial imagery + elevation) as circularly-
 * selected chunks aligned to Web Mercator map tiles, loading/unloading
 * around a moving player position, at two levels of detail:
 *
 *  - "detail" tier: full-res aerial-textured mesh + matching Cannon-es
 *    Trimesh physics body (built from the exact same vertices, so visuals
 *    and collision are always perfectly aligned), kept loaded within
 *    DETAIL_RADIUS tiles of the player.
 *  - "far" tier: a coarse, texture-less, physics-less backdrop extending
 *    the visible horizon out to FAR_RADIUS_METERS.
 */
export class TerrainManager {
  constructor(scene, world, originLat, originLon) {
    this.scene = scene;
    this.world = world;
    this.originLat = originLat;
    this.originLon = originLon;
    this.chunks = new Map(); // key -> { mesh, body, border, tx, ty, bytes }
    this.pending = new Set(); // keys currently being fetched (planned to be created)
    this.pendingRemoval = new Map(); // key -> ticks remaining before actual unload
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
    const holeRadiusMeters = (DETAIL_RADIUS + UNLOAD_MARGIN + 1) * tileSizeMeters(DETAIL_ZOOM, originLat);
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
    this._lastCenter = null;
    this._centerX = 0;
    this._centerY = 0;
    this._lastFarCenter = null;
    this._farCenterX = 0;
    this._farCenterY = 0;

    this.originLat = lat;
    this.originLon = lon;
    this.farRadiusTiles = FAR_RADIUS_METERS / tileSizeMeters(FAR_ZOOM, lat);
    const holeRadiusMeters = (DETAIL_RADIUS + UNLOAD_MARGIN + 1) * tileSizeMeters(DETAIL_ZOOM, lat);
    this.holeUniforms.radiusSq.value = holeRadiusMeters * holeRadiusMeters;

    await this.init();
  }

  async _loadChunk(tx, ty) {
    const key = this._key(tx, ty);
    if (this.chunks.has(key) || this.pending.has(key)) return;
    this.pending.add(key);
    try {
      // Elevation failures (e.g. a rejected/rate-limited API request) are
      // tolerated with a flat fallback rather than dropping the whole
      // chunk - a flat patch of ground is much safer than a hole the car
      // could physically fall through, and it self-heals next time the
      // chunk streams back in range and the fetch happens to succeed.
      const [colorTex, elevImg] = await Promise.all([
        loadAerialTexture(DETAIL_ZOOM, tx, ty),
        loadImage(ELEVATION_URL(DETAIL_ZOOM, tx, ty)).catch((err) => {
          console.warn('Detail chunk elevation fetch failed, using flat fallback', tx, ty, err);
          return null;
        }),
      ]);
      const elevGrid = elevImg ? decodeElevationTile(elevImg) : null;

      const geometry = new THREE.PlaneGeometry(1, 1, DETAIL_GRID, DETAIL_GRID);
      const position = geometry.attributes.position;
      for (let iy = 0; iy <= DETAIL_GRID; iy++) {
        for (let ix = 0; ix <= DETAIL_GRID; ix++) {
          const idx = iy * (DETAIL_GRID + 1) + ix;
          const u = ix / DETAIL_GRID;
          const v = iy / DETAIL_GRID;
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

      // Visual boundary: a line loop traced around the tile's perimeter so
      // adjacent chunks are distinguishable at a glance in the 3D view.
      // Part of the debug visuals, so it respects the current toggle state.
      const border = buildTileBorder(geometry, DETAIL_GRID);
      border.visible = this.bordersVisible;
      this.scene.add(border);

      // Physics: Trimesh built from the exact same vertices/indices as the
      // visual mesh (both live in world space, body at identity transform),
      // so collision can never drift out of alignment with what's rendered.
      const vertices = Array.from(position.array);
      const indices = Array.from(geometry.index.array);
      const shape = new CANNON.Trimesh(vertices, indices);
      const body = new CANNON.Body({ mass: 0 });
      body.collisionFilterGroup = GROUND_COLLISION_GROUP;
      body.addShape(shape);
      this.world.addBody(body);

      const bytes =
        estimateChunkBytes(colorTex.image, position.array, indices) +
        border.geometry.attributes.position.array.length * 4;

      this.chunks.set(key, { mesh, body, border, tx, ty, bytes });
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
    chunk.border.material.dispose();
    this.world.removeBody(chunk.body);
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

      const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
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

  /** Toggles the perimeter border lines on all currently-loaded chunks (and future ones). */
  setBordersVisible(visible) {
    this.bordersVisible = visible;
    for (const chunk of this.chunks.values()) chunk.border.visible = visible;
  }

  /**
   * Ensures chunks around (localX, localZ) are loaded, and unloads chunks
   * that have fallen far enough outside the load radius. Both the detail
   * and far tiers are driven from the same call, each on its own tile grid.
   * Pass `await` (via awaitAll=true) to block until the initial batch is ready.
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
    for (const { dx, dy } of circleOffsets(DETAIL_RADIUS)) {
      wanted.push(this._loadChunk(centerX + dx, centerY + dy));
    }
    for (const { dx, dy } of circleOffsets(this.farRadiusTiles)) {
      wanted.push(this._loadFarChunk(farCenterX + dx, farCenterY + dy));
    }
    if (awaitAll) await Promise.all(wanted);

    // Cleanup pass: chunks outside keepRadius are staged into
    // `pendingRemoval` with a tick countdown rather than unloaded on the
    // spot. Anything that drifts back inside the radius before its
    // countdown expires (e.g. the player briefly reverses) is rescued and
    // kept loaded, avoiding pointless reload/unload thrashing at the edge.
    const keepRadius = DETAIL_RADIUS + UNLOAD_MARGIN;
    for (const [k, chunk] of this.chunks) {
      const farAway = !inCircle(chunk.tx - centerX, chunk.ty - centerY, keepRadius);
      if (farAway) {
        if (!this.pendingRemoval.has(k)) this.pendingRemoval.set(k, UNLOAD_DELAY_TICKS);
      } else {
        this.pendingRemoval.delete(k);
      }
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
   * a small square "map" grid (centered on the player) tagging every
   * detail-tier tile in view as loaded / pending-create / pending-remove /
   * empty. Far-tier totals are reported as aggregate counts only (its
   * footprint is far too large to usefully render as a HUD grid).
   */
  getStats() {
    let memoryBytes = 0;
    for (const chunk of this.chunks.values()) memoryBytes += chunk.bytes || 0;
    let farMemoryBytes = 0;
    for (const chunk of this.farChunks.values()) farMemoryBytes += chunk.bytes || 0;

    const keepRadius = DETAIL_RADIUS + UNLOAD_MARGIN;
    const grid = [];
    for (let dy = -keepRadius; dy <= keepRadius; dy++) {
      const row = [];
      for (let dx = -keepRadius; dx <= keepRadius; dx++) {
        const tx = this._centerX + dx;
        const ty = this._centerY + dy;
        const k = this._key(tx, ty);
        let state = 'empty';
        if (this.pendingRemoval.has(k)) state = 'removing';
        else if (this.chunks.has(k)) state = 'loaded';
        else if (this.pending.has(k)) state = 'pending';
        row.push(dx === 0 && dy === 0 ? 'player' : state);
      }
      grid.push(row);
    }

    return {
      loaded: this.chunks.size,
      pending: this.pending.size,
      pendingRemoval: this.pendingRemoval.size,
      created: this.stats.created,
      removed: this.stats.removed,
      memoryBytes,
      center: { tx: this._centerX, ty: this._centerY },
      radius: keepRadius,
      grid,
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
