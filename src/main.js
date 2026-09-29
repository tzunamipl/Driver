import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { createCar } from './lib/car.js';
import { TerrainManager, GROUND_COLLISION_GROUP, DETAIL_ZOOM } from './lib/terrain.js';
import { BuildingsManager } from './lib/buildings.js';
import { lon2tileX, lat2tileY, localToLatLon } from './lib/geo.js';

// Real-world spawn location (Wroclaw city center). The terrain streams in
// real aerial imagery + elevation around wherever the car currently is, so
// you can drive anywhere on Earth from here - it's just the starting point.
const ORIGIN_LAT = 51.1079;
const ORIGIN_LON = 17.0385;

// ---------- Renderer / Scene / Camera ----------
const app = document.getElementById('app');

// Logarithmic depth buffer: needed because the view now spans from ~0.1m
// (car interior/wheels) out to the far-LOD terrain tier tens of km away
// (see terrain.js FAR_RADIUS_METERS) - a standard depth buffer doesn't have
// enough precision across that range and would z-fight badly at distance.
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
// Exponential-squared fog: unlike a linear Fog with a hard far cutoff, this
// fades gradually and asymptotically - near the car it's barely noticeable
// (so nearby detail stays crisp), while it naturally swallows the far-LOD
// terrain into the sky color by tens of km out, mimicking real atmospheric
// haze instead of hard-clipping distant terrain out of view entirely.
scene.fog = new THREE.FogExp2(0x87ceeb, 0.00005);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.1,
  // Far plane must reach past the far-LOD terrain tier's radius (see
  // terrain.js FAR_RADIUS_METERS = 150km) or that whole tier gets
  // frustum-culled and is never rendered no matter how the fog is tuned.
  160_000
);
camera.position.set(0, 5, -8);


// ---------- Lighting ----------
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
const SUN_OFFSET = new THREE.Vector3(50, 80, 30);
sun.position.copy(SUN_OFFSET);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -100;
sun.shadow.camera.right = 100;
sun.shadow.camera.top = 100;
sun.shadow.camera.bottom = -100;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 300;
scene.add(sun);
scene.add(sun.target);

// ---------- Physics world ----------
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.defaultContactMaterial.friction = 0.05;

// ---------- Real-world terrain (aerial imagery + elevation, streamed) ----------
const terrain = new TerrainManager(scene, world, ORIGIN_LAT, ORIGIN_LON);
// ---------- 3D buildings (OpenStreetMap footprints, streamed) ----------
const buildings = new BuildingsManager(scene, world, ORIGIN_LAT, ORIGIN_LON);
// Tracks whichever lat/lon the local (0,0) origin currently represents -
// starts at ORIGIN_LAT/LON but is repointed by the address search flow
// (terrain.recenter / buildings.recenter) whenever the car respawns
// elsewhere. Needed to convert the car's local position back to lat/lon
// for building-tile streaming (see animate()) after a respawn.
let currentOriginLat = ORIGIN_LAT;
let currentOriginLon = ORIGIN_LON;

const loadingEl = document.createElement('div');
loadingEl.textContent = 'Loading real-world terrain\u2026';
Object.assign(loadingEl.style, {
  position: 'fixed',
  inset: '0',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#87ceeb',
  color: '#1a1a1a',
  font: '600 20px system-ui, sans-serif',
  zIndex: '10',
});
document.body.appendChild(loadingEl);

// ---------- Car ----------
// Start a few meters back along -Z (opposite of the car's forward +Z). Y is a
// small drop height above the (roughly zeroed) terrain at the origin; gravity
// settles it onto the real ground once the chunk physics bodies are loaded.
const START_POS = new CANNON.Vec3(0, 3, -5);
const START_QUAT = new CANNON.Quaternion();
let vehicle, chassisMesh, syncMeshes, snapshotPhysics, reset, setCarHitboxVisible;

// ---------- Keyboard controls ----------
const keys = new Set();
window.addEventListener('keydown', (e) => keys.add(e.code));
window.addEventListener('keyup', (e) => keys.delete(e.code));

const MAX_FORCE = 300;
const MAX_STEER = 0.5;
// Brakes should be able to stop the car at least as decisively as the engine
// can accelerate it, so scale brake force off the engine's max power instead
// of using an unrelated fixed constant.
const BRAKE_FORCE = MAX_FORCE * 10;

function updateControls() {
  if (!vehicle) return;
  const forward = keys.has('KeyW') || keys.has('ArrowUp');
  const backward = keys.has('KeyS') || keys.has('ArrowDown');
  const left = keys.has('KeyA') || keys.has('ArrowLeft');
  const right = keys.has('KeyD') || keys.has('ArrowRight');
  const handbrake = keys.has('Space');

  const engineForce = forward ? -MAX_FORCE : backward ? MAX_FORCE : 0;
  // rear-wheel drive (indices 2, 3)
  vehicle.applyEngineForce(engineForce, 2);
  vehicle.applyEngineForce(engineForce, 3);

  const steerValue = left ? MAX_STEER : right ? -MAX_STEER : 0;
  vehicle.setSteeringValue(steerValue, 0);
  vehicle.setSteeringValue(steerValue, 1);

  const brakeForce = handbrake ? BRAKE_FORCE : 0;
  for (let i = 0; i < 4; i++) vehicle.setBrake(brakeForce, i);

  if (keys.has('KeyR')) {
    reset();
  }
}

// ---------- Gauges (speedometer + compass) ----------
const speedoNeedle = document.getElementById('speedo-needle');
const speedoValue = document.getElementById('speedo-value');
const compassDial = document.getElementById('compass-dial');
const compassValue = document.getElementById('compass-value');
const terrainStatsEl = document.getElementById('terrain-stats');
const suspensionHudEl = document.getElementById('suspension-hud');

// Wheel order matches vehicle.wheelInfos indices (see car.js: front-left,
// front-right, rear-left, rear-right).
const SUSPENSION_WHEELS = ['fl', 'fr', 'rl', 'rr'].map((key) => ({
  key,
  fill: document.getElementById(`susp-${key}-fill`),
  val: document.getElementById(`susp-${key}-val`),
}));

// ---------- Debug visuals toggle (tile stats HUD, 3D tile borders, and
// collision hitbox wireframes for buildings + the car chassis) ----------
// On by default; press M to hide/show all of these together while driving.
let debugVisualsEnabled = true;

function setDebugVisualsEnabled(enabled) {
  debugVisualsEnabled = enabled;
  terrainStatsEl.style.display = enabled ? '' : 'none';
  suspensionHudEl.style.display = enabled ? '' : 'none';
  terrain.setBordersVisible(enabled);
  buildings.setHitboxesVisible(enabled);
  if (setCarHitboxVisible) setCarHitboxVisible(enabled);
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !e.repeat) setDebugVisualsEnabled(!debugVisualsEnabled);
});

setDebugVisualsEnabled(debugVisualsEnabled);


const MAX_GAUGE_SPEED = 180; // km/h at full needle deflection
const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const forwardVec = new THREE.Vector3();

// Tracks the dial's continuous (unwrapped) rotation so the CSS transition
// always nudges across the shortest arc instead of snapping the long way
// around whenever the heading crosses the 0/360 boundary.
let compassDialRotation = 0;

function updateGauges() {
  if (!chassisMesh || !vehicle) return;

  // Speed: physics velocity magnitude (m/s) -> km/h.
  const v = vehicle.chassisBody.velocity;
  const speedKmh = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * 3.6;
  const clamped = Math.min(speedKmh, MAX_GAUGE_SPEED);
  // Needle sweeps -90deg (0 km/h) to +90deg (MAX_GAUGE_SPEED).
  const needleDeg = -90 + (clamped / MAX_GAUGE_SPEED) * 180;
  speedoNeedle.style.transform = `translate(-50%, -100%) rotate(${needleDeg}deg)`;
  speedoValue.textContent = Math.round(speedKmh);

  // Heading: project the chassis' local forward axis onto the world XZ plane.
  // World +z is south (see DIRECTIONS below), so north is -z; negate z here
  // to match that convention and keep the dial's N/S/E/W labels correct.
  forwardVec.set(0, 0, 1).applyQuaternion(chassisMesh.quaternion);
  let headingDeg = THREE.MathUtils.radToDeg(Math.atan2(forwardVec.x, -forwardVec.z));
  headingDeg = (headingDeg + 360) % 360;

  // Rotate the dial opposite the heading so the fixed top pointer always
  // shows the direction the car is currently facing. Unwrap against the
  // previous rotation so the dial always takes the shortest turn, rather
  // than jumping a full lap when headingDeg wraps past 0/360.
  const targetRotation = -headingDeg;
  let delta = ((targetRotation - compassDialRotation + 180) % 360 + 360) % 360 - 180;
  compassDialRotation += delta;
  compassDial.style.transform = `rotate(${compassDialRotation}deg)`;
  const pointIndex = Math.round(headingDeg / 45) % 8;
  compassValue.textContent = COMPASS_POINTS[pointIndex];
}

// ---------- Terrain stats HUD (memory usage + tile streaming map) ----------
// 8-direction lookup, ordered to match on-screen layout: grid columns are
// tile-x (world +x/east, left->right) and grid rows are tile-y (world
// +z/south, top->bottom) - see geo.js. So a direction's (dx, dy) here maps
// 1:1 onto how many cells to step right/down in the rendered grid, and the
// arrow glyphs point the same way on screen as the car is actually heading.
const DIRECTIONS = [
  { dx: 0, dy: -1, arrow: '\u2191' }, // N (up)
  { dx: 1, dy: -1, arrow: '\u2197' }, // NE
  { dx: 1, dy: 0, arrow: '\u2192' }, // E (right)
  { dx: 1, dy: 1, arrow: '\u2198' }, // SE
  { dx: 0, dy: 1, arrow: '\u2193' }, // S (down)
  { dx: -1, dy: 1, arrow: '\u2199' }, // SW
  { dx: -1, dy: 0, arrow: '\u2190' }, // W (left)
  { dx: -1, dy: -1, arrow: '\u2196' }, // NW
];

let statsAccum = 0;
const STATS_UPDATE_INTERVAL = 0.25; // seconds; DOM updates don't need to happen every frame

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Snaps the car's current world-space forward vector to one of 8 compass directions. */
function headingDirection() {
  const angleDeg =
    (THREE.MathUtils.radToDeg(Math.atan2(forwardVec.x, -forwardVec.z)) + 360) % 360;
  const index = Math.round(angleDeg / 45) % 8;
  return DIRECTIONS[index];
}

function updateTerrainStats(delta) {
  if (!debugVisualsEnabled) return;
  statsAccum += delta;
  if (statsAccum < STATS_UPDATE_INTERVAL) return;
  statsAccum = 0;

  const s = terrain.getStats();
  const dir = headingDirection();
  const aheadTx = s.center.tx + dir.dx;
  const aheadTy = s.center.ty + dir.dy;

  const b = buildings.getStats();
  const textLines = [
    'TERRAIN',
    `detail: ${s.loaded} loaded  ${s.pending} loading  ${s.pendingRemoval} removing`,
    `far:    ${s.far.loaded} loaded  ${s.far.pending} loading  ${s.far.pendingRemoval} removing`,
    `created: ${s.created}/${s.far.created}  removed: ${s.removed}/${s.far.removed}`,
    `~memory: ${formatBytes(s.memoryBytes + s.far.memoryBytes)}`,
    `ahead: ${aheadTx},${aheadTy}`,
    `buildings: ${b.buildings} in ${b.loaded} tiles${b.regionLoading ? ' (region loading\u2026)' : ''}  ~${formatBytes(b.memoryBytes)}`,
  ];
  if (b.usingCachedData) {
    textLines.push(`buildings: offline \u2013 showing cached data from local storage`);
  } else if (b.regionFailed) {
    textLines.push(`buildings: tile service unreachable (network blocked?), retrying\u2026`);
    if (b.lastError) textLines.push(`  ${b.lastError.slice(0, 60)}`);
  }

  const cols = s.grid[0].length;
  terrainStatsEl.innerHTML =
    `<div class="ts-text">${textLines.join('\n')}</div>` +
    `<div class="ts-compass-wrap">` +
    `<span class="ts-dir n">N</span><span class="ts-dir s">S</span>` +
    `<span class="ts-dir w">W</span><span class="ts-dir e">E</span>` +
    `<div class="ts-grid" style="grid-template-columns: repeat(${cols}, 14px)">` +
    s.grid
      .map((row, ry) =>
        row
          .map((state, rx) => {
            const isPlayer = state === 'player';
            const cellState = isPlayer ? 'loaded' : state;
            const isAhead = ry - s.radius === dir.dy && rx - s.radius === dir.dx;
            const classes = ['ts-cell', cellState];
            if (isPlayer) classes.push('player');
            if (isAhead) classes.push('ahead');
            const glyph = isPlayer ? dir.arrow : '';
            return `<span class="${classes.join(' ')}">${glyph}</span>`;
          })
          .join('')
      )
      .join('') +
    `</div></div>` +
    `<div class="ts-legend">` +
    `<span><span class="swatch" style="background:rgba(76,175,80,0.7)"></span>loaded</span>` +
    `<span><span class="swatch" style="background:rgba(255,193,7,0.7)"></span>planned</span>` +
    `<span><span class="swatch" style="background:rgba(244,67,54,0.55)"></span>removing</span>` +
    `<span><span class="swatch" style="background:rgba(255,255,255,0.1)"></span>empty</span>` +
    `<span>${dir.arrow} you / ahead highlighted</span>` +
    `</div>`;
}

/**
 * Colors a suspension bar by how hard the spring is working: blue for
 * normal travel, yellow as it approaches full compression, red once it's
 * essentially bottomed out (spring at/near its max travel limit).
 */
function suspensionColor(compressionFrac) {
  if (compressionFrac > 0.85) return '#ff5b5b';
  if (compressionFrac > 0.6) return '#ffce4f';
  return '#4fc3ff';
}

/**
 * Updates the bottom-left suspension HUD: one vertical bar per wheel
 * showing live spring travel, read straight from each wheel's Cannon-es
 * WheelInfo. A bar's fill height is 0% at full droop (fully extended) and
 * 100% at full compression (bottomed out), with a rest-length marker line
 * fixed at 50% - so the fill visibly moves up as a wheel loads/compresses
 * (cornering, braking, bumps) and down as it unloads/droops (cresting a
 * bump, airborne). Wheels not currently touching the ground are dimmed and
 * shown resting at the midpoint, since cannon-es reports their suspension
 * as fully extended (no ground to push back against) while airborne.
 */
function updateSuspensionHud() {
  if (!debugVisualsEnabled || !vehicle) return;

  vehicle.wheelInfos.forEach((wheel, i) => {
    const { fill, val } = SUSPENSION_WHEELS[i];
    const minLength = wheel.suspensionRestLength - wheel.maxSuspensionTravel;
    const maxLength = wheel.suspensionRestLength + wheel.maxSuspensionTravel;
    const span = maxLength - minLength || 1;
    const clampedLength = Math.min(maxLength, Math.max(minLength, wheel.suspensionLength));
    const compressionFrac = (maxLength - clampedLength) / span;

    fill.style.height = `${Math.round(compressionFrac * 100)}%`;
    fill.style.background = wheel.isInContact
      ? suspensionColor(compressionFrac)
      : 'rgba(255, 255, 255, 0.25)';
    val.textContent = wheel.isInContact ? `${Math.round(compressionFrac * 100)}%` : 'air';
  });
}


// ---------- Camera follow ----------
const cameraOffset = new THREE.Vector3(0, 30, -20);
const cameraLookOffset = new THREE.Vector3(0, 10.5, 10);
const tmpVec = new THREE.Vector3();
const tmpForward = new THREE.Vector3();
const tmpCarUp = new THREE.Vector3();
const yawQuat = new THREE.Quaternion();
const upVec = new THREE.Vector3(0, 1, 0);
const smoothedLookAt = new THREE.Vector3();
let smoothedLookAtInit = false;
let lastYaw = 0;
let smoothedYaw = 0;
let smoothedYawInit = false;

// Lower = smoother/slower camera pan, so crashes don't whip the camera around.
const CAMERA_POSITION_SPEED = 2.5;
const CAMERA_LOOKAT_SPEED = 3;
// Raw yaw (from the chassis quaternion) carries small high-frequency noise
// from suspension/wheel-contact vibration, which gets amplified a lot by
// the long camera offset (~36 units) into visible high-speed jitter. Smooth
// the yaw angle itself (not just the final position) to filter that noise
// out while still turning briskly with real heading changes.
const CAMERA_YAW_SPEED = 6;

// Below this dot(carUp, worldUp) the car is considered "flipped" (on its
// roof/side, tumbling mid-crash, etc.) - roughly more than ~60 degrees of
// tilt. Projecting the forward vector to get a yaw becomes unstable/
// meaningless once the car is that far from upright (it can spin the
// camera rapidly during a barrel roll), so we just freeze the last good
// yaw and hold the camera steady until the car is upright again.
const FLIP_UP_DOT_THRESHOLD = 0.5;

// Below this horizontal speed (m/s) the velocity direction is too noisy/
// undefined (e.g. standing still, or barely rolling) to aim the camera at,
// so we fall back to the chassis heading instead.
const CAMERA_MIN_SPEED_FOR_VELOCITY_YAW = 1;

function updateCamera(delta) {
  if (!chassisMesh || !vehicle) return;
  const carPos = chassisMesh.position;
  const carQuat = chassisMesh.quaternion;

  tmpCarUp.set(0, 1, 0).applyQuaternion(carQuat);
  const isFlipped = tmpCarUp.dot(upVec) < FLIP_UP_DOT_THRESHOLD;

  let yaw = lastYaw;
  if (!isFlipped) {
    // Point the camera where the car is actually moving (its velocity
    // direction) rather than where it's heading (its forward axis), so
    // e.g. sliding/drifting sideways or reversing looks correct. Only the
    // horizontal (XZ) component is used - pitch/roll from bumps or rolling
    // must never tilt the camera off the horizontal plane (no-roll rule).
    const vel = vehicle.chassisBody.velocity;
    tmpForward.set(vel.x, 0, vel.z);
    if (tmpForward.lengthSq() < CAMERA_MIN_SPEED_FOR_VELOCITY_YAW * CAMERA_MIN_SPEED_FOR_VELOCITY_YAW) {
      // Too slow for velocity direction to be meaningful - use the car's
      // facing direction instead so the camera doesn't spin/jitter at
      // near-zero speed.
      tmpForward.set(0, 0, 1).applyQuaternion(carQuat);
      tmpForward.y = 0;
    }
    if (tmpForward.lengthSq() < 1e-8) tmpForward.set(0, 0, 1);
    tmpForward.normalize();
    yaw = Math.atan2(tmpForward.x, tmpForward.z);
    lastYaw = yaw;
  }

  // Smooth the yaw angle itself (shortest-path, wrap-safe) instead of using
  // the raw per-frame value directly - this is what actually decouples the
  // camera from small heading vibrations instead of just smoothing the
  // already-noisy rotated offset.
  if (!smoothedYawInit) {
    smoothedYaw = yaw;
    smoothedYawInit = true;
  } else {
    const yawDiff = Math.atan2(Math.sin(yaw - smoothedYaw), Math.cos(yaw - smoothedYaw));
    const yawFactor = 1 - Math.exp(-CAMERA_YAW_SPEED * delta);
    smoothedYaw += yawDiff * yawFactor;
  }
  yawQuat.setFromAxisAngle(upVec, smoothedYaw);

  // Frame-rate independent exponential smoothing, so panning speed stays
  // consistent regardless of delta time (e.g. during rapid crash motion).
  const posFactor = 1 - Math.exp(-CAMERA_POSITION_SPEED * delta);
  const lookFactor = 1 - Math.exp(-CAMERA_LOOKAT_SPEED * delta);

  tmpVec.copy(cameraOffset).applyQuaternion(yawQuat).add(carPos);
  camera.position.lerp(tmpVec, posFactor);

  const lookAt = cameraLookOffset.clone().applyQuaternion(yawQuat).add(carPos);
  if (!smoothedLookAtInit) {
    smoothedLookAt.copy(lookAt);
    smoothedLookAtInit = true;
  } else {
    smoothedLookAt.lerp(lookAt, lookFactor);
  }
  camera.lookAt(smoothedLookAt);
  camera.up.set(0, 1, 0);
}

// ---------- Resize ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Address search / respawn ----------
// Free, keyless geocoding via OpenStreetMap's Nominatim, matching the
// project's "no API keys" philosophy (see README). Given a free-text
// address, resolves it to lat/lon, re-centers the whole terrain streaming
// system on that point (see TerrainManager.recenter), and teleports the
// car back to the local origin once the new area's initial chunks load.
const NOMINATIM_URL = (q) =>
  `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;

async function geocodeAddress(query) {
  const res = await fetch(NOMINATIM_URL(query), {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`geocoding request failed (${res.status})`);
  const results = await res.json();
  if (!results.length) throw new Error('address not found');
  return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
}

const addressForm = document.getElementById('address-search');
const addressInput = document.getElementById('address-input');
const addressSubmit = document.getElementById('address-submit');
const addressStatusEl = document.getElementById('address-search-status');

function setAddressStatus(text, isError = false) {
  addressStatusEl.textContent = text;
  addressStatusEl.style.display = text ? 'block' : 'none';
  addressStatusEl.style.color = isError ? '#ff8080' : '#fff';
}

let respawning = false;

addressForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = addressInput.value.trim();
  if (!query || respawning) return;

  respawning = true;
  addressSubmit.disabled = true;
  setAddressStatus(`Searching for "${query}"\u2026`);

  try {
    const { lat, lon } = await geocodeAddress(query);
    setAddressStatus('Loading terrain at new location\u2026');
    await terrain.recenter(lat, lon);
    buildings.recenter(lat, lon);
    currentOriginLat = lat;
    currentOriginLon = lon;
    await buildings.update(
      Math.floor(lon2tileX(lon, DETAIL_ZOOM)),
      Math.floor(lat2tileY(lat, DETAIL_ZOOM)),
      true
    );
    if (reset) reset(START_POS, START_QUAT);
    setAddressStatus(`Respawned at "${query}"`);
    setTimeout(() => setAddressStatus(''), 3000);
  } catch (err) {
    console.warn('Address respawn failed', err);
    setAddressStatus(`Couldn't respawn: ${err.message}`, true);
  } finally {
    respawning = false;
    addressSubmit.disabled = false;
  }
});

// ---------- Main loop ----------
const FIXED_STEP = 1 / 60;
const MAX_SUBSTEPS = 5;
let lastTime = performance.now();
let accumulator = 0;

// Fast tumbling during a flip can move the chassis box far enough in a single
// physics step that narrowphase collision with the terrain trimesh misses
// entirely (classic tunneling), letting the car fall through the ground.
// As a safety net, cast a ray straight down through the chassis every frame
// and clamp it back above the terrain surface if it ever ends up embedded.
const GROUND_RAY_FROM = new CANNON.Vec3();
const GROUND_RAY_TO = new CANNON.Vec3();
const groundRayResult = new CANNON.RaycastResult();
const GROUND_RAY_HEIGHT = 50;
const MIN_GROUND_CLEARANCE = 0.05;

function preventGroundTunneling() {
  if (!vehicle) return;
  const pos = vehicle.chassisBody.position;
  GROUND_RAY_FROM.set(pos.x, pos.y + GROUND_RAY_HEIGHT, pos.z);
  GROUND_RAY_TO.set(pos.x, pos.y - GROUND_RAY_HEIGHT, pos.z);
  groundRayResult.reset();
  world.raycastClosest(
    GROUND_RAY_FROM,
    GROUND_RAY_TO,
    { collisionFilterMask: GROUND_COLLISION_GROUP },
    groundRayResult
  );

  if (groundRayResult.hasHit) {
    const minY = groundRayResult.hitPointWorld.y + MIN_GROUND_CLEARANCE;
    if (pos.y < minY) {
      pos.y = minY;
      if (vehicle.chassisBody.velocity.y < 0) vehicle.chassisBody.velocity.y = 0;
    }
  }
}

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const frameDelta = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  updateControls();

  // Advance physics in fixed-size steps (accumulator pattern) instead of a
  // single variable-size world.step() call. requestAnimationFrame deltas
  // rarely divide evenly into FIXED_STEP, so letting cannon-es pick its own
  // substep count each frame makes that count flicker (e.g. 1, 1, 2, 1...),
  // which reads as jitter/stutter at high speed even though the underlying
  // motion is smooth. Stepping fixed-size chunks ourselves and interpolating
  // the render transform (see snapshotPhysics/syncMeshes) removes that.
  accumulator += frameDelta;
  let substeps = 0;
  while (accumulator >= FIXED_STEP && substeps < MAX_SUBSTEPS) {
    world.step(FIXED_STEP);
    preventGroundTunneling();
    if (snapshotPhysics) snapshotPhysics();
    accumulator -= FIXED_STEP;
    substeps++;
  }
  // If we're badly lagging (hit MAX_SUBSTEPS), drop the remainder instead of
  // letting it snowball into a "spiral of death" of ever-growing catch-up.
  if (accumulator > FIXED_STEP) accumulator = accumulator % FIXED_STEP;

  const alpha = accumulator / FIXED_STEP;
  if (syncMeshes) syncMeshes(alpha);
  updateCamera(frameDelta);
  updateGauges();
  updateTerrainStats(frameDelta);
  updateSuspensionHud();

  if (chassisMesh) {
    // Keep the sun (and its shadow frustum) centered on the car so shadows
    // keep rendering as it drives away from the spawn point.
    sun.position.copy(SUN_OFFSET).add(chassisMesh.position);
    sun.target.position.copy(chassisMesh.position);
    sun.target.updateMatrixWorld();

    // Stream terrain chunks in/out as the car moves (cheap no-op if the
    // player is still inside the currently-loaded tile).
    terrain.update(chassisMesh.position.x, chassisMesh.position.z);

    // Buildings stream on the same DETAIL_ZOOM tile grid as the terrain
    // detail tier; compute the current tile center the same way
    // TerrainManager.update() does internally so the two stay aligned.
    const { lat: carLat, lon: carLon } = localToLatLon(
      chassisMesh.position.x,
      chassisMesh.position.z,
      currentOriginLat,
      currentOriginLon
    );
    buildings.update(
      Math.floor(lon2tileX(carLon, DETAIL_ZOOM)),
      Math.floor(lat2tileY(carLat, DETAIL_ZOOM))
    );
  }

  renderer.render(scene, camera);
}

// Load the initial terrain around the spawn point before starting the sim,
// so the car never falls through an unloaded world. Buildings stream in
// via the same per-frame animate() call once the car exists (see the
// buildings.update() call above) - not awaited here, since building tiles
// are slower/less critical than the aerial/elevation tile sources and
// terrain-only is enough to safely start driving.
terrain.init().then(() => {
  loadingEl.remove();
  ({ vehicle, chassisMesh, syncMeshes, snapshotPhysics, reset, setHitboxVisible: setCarHitboxVisible } = createCar(
    world,
    scene,
    START_POS,
    START_QUAT
  ));
  setCarHitboxVisible(debugVisualsEnabled);
  animate();
});
