import * as CANNON from 'cannon-es';
import { createNet } from './lib/net.js';
import { createRemoteCollisions } from './lib/remoteCollisions.js';
import { TerrainManager, GROUND_COLLISION_GROUP } from './lib/terrain.js';
import { remapLocalOrigin } from './lib/geo.js';
import { createPedestrians } from './lib/pedestrians.js';
import { createBalls } from './lib/ball.js';
import { createShots } from './lib/shots.js';
import { createHorn } from './lib/horn.js';
import { createJump } from './lib/jump.js';
import { createMusic } from './lib/music.js';
import { BuildingsManager } from './lib/buildings.js';
import { StreetsManager } from './lib/streets.js';
import { RiversManager } from './lib/rivers.js';
import { WaterAreasManager } from './lib/waterAreas.js';
import { loadCarState } from './lib/carState.js';
import { loadOrCreatePlayerId } from './lib/playerId.js';

import { ORIGIN_LAT, ORIGIN_LON, DEFAULT_BODY_COLOR, IS_DEV_MODE, SCORE_PER_CAR_HIT } from './config.js';
import { createSceneEnvironment, createLighting } from './app/sceneSetup.js';
import { createPhysicsWorld } from './app/physicsSetup.js';
import { createGroundTunnelGuard, createBuildingTunnelGuard, createBuildingEmbedGuard } from './app/collisions.js';
import { createCameraFollow } from './app/cameraFollow.js';
import { createInputController } from './app/input.js';
import { createCarManager } from './app/carManager.js';
import { setupGameplayProps } from './app/gameplayProps.js';
import { createMainLoop } from './app/mainLoop.js';
import { createScoring } from './app/scoring.js';
import { createScoreToast } from './hud/scoreToast.js';
import { createNoticeHud } from './hud/notice.js';
import { createAirtimeHud } from './hud/airtimeHud.js';
import { createGaugesHud } from './hud/gauges.js';
import { createTerrainStatsHud } from './hud/terrainStatsHud.js';
import { createSuspensionHud } from './hud/suspensionHud.js';
import { createMinimapHud } from './hud/minimap.js';
import { createPlayersPanel } from './hud/playersPanel.js';
import { setupCollapsibleHud } from './hud/collapsible.js';
import { setupTouchControls } from './hud/touchControls.js';
import { createDebugVisualsToggle } from './hud/debugVisuals.js';
import { createVehicleDebugPicker } from './hud/vehicleDebugPicker.js';
import { createVersionBadge } from './hud/versionBadge.js';
import { createAddressSearch } from './ui/addressSearch.js';
import { createLobby } from './ui/lobby.js';

// ---------- Composition root ----------
// This file only wires modules together in the right order; all actual
// logic (physics, terrain/buildings streaming, camera, HUD, input,
// networking UI, gameplay) lives in ./app, ./hud, ./ui, and ./lib - see
// those folders to work on a specific concern without touching this file.

// ---------- Rendering environment ----------
const { renderer, scene, camera } = createSceneEnvironment();
const { sun, SUN_OFFSET } = createLighting(scene);

// ---------- Physics world ----------
const world = createPhysicsWorld();
const remoteCollisions = createRemoteCollisions(world);
const pedestrians = createPedestrians(scene, world, GROUND_COLLISION_GROUP);
const balls = createBalls(scene, world);
const noticeHud = createNoticeHud();
const preventGroundTunneling = createGroundTunnelGuard(
  world,
  () => {
    // The network/world origin, remapped into *this* player's current local
    // frame (see mainLoop.js's toViewFrame for the same remap applied to
    // remote poses) - i.e. "wherever the game's own starting location is,
    // expressed in local scene coordinates right now". Computed fresh on
    // every call (rather than once) since a personal teleport (see
    // ui/addressSearch.js) changes that mapping at runtime; this is what the
    // ground-tunnel guard rescues a body to if it's stuck somewhere with no
    // terrain data at all (e.g. a teleport destination outside the map's
    // coverage), since the player's *current* position is exactly the place
    // that's already proven to have no ground.
    const { lat, lon } = addressSearch.getCurrentOrigin();
    return remapLocalOrigin(0, 0, ORIGIN_LAT, ORIGIN_LON, lat, lon);
  },
  () =>
    noticeHud.show(
      "Couldn't find any ground under your car for a while, so you've been teleported back to the starting location."
    )
);
const buildingTunnelGuard = createBuildingTunnelGuard(world);
const preventBuildingEmbedding = createBuildingEmbedGuard(world);

// ---------- Real-world terrain + 3D buildings (streamed) ----------
const terrain = new TerrainManager(scene, world, ORIGIN_LAT, ORIGIN_LON);
const buildings = new BuildingsManager(scene, world, ORIGIN_LAT, ORIGIN_LON);
const streets = new StreetsManager(scene, world, ORIGIN_LAT, ORIGIN_LON);
const rivers = new RiversManager(scene, world, ORIGIN_LAT, ORIGIN_LON);
const waterAreas = new WaterAreasManager(scene, world, ORIGIN_LAT, ORIGIN_LON);

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

// ---------- Networking ----------
// Reuse the same clientId across reloads (see lib/playerId.js) so this
// browser doesn't show up as a fresh duplicate peer every time the page
// is refreshed.
const net = createNet({ clientId: loadOrCreatePlayerId() });

// ---------- Car spawn point ----------
// Start a few meters back along -Z (opposite of the car's forward +Z). Y is
// a small drop height above the (roughly zeroed) terrain at the origin;
// gravity settles it onto the real ground once the chunk physics bodies
// are loaded.
const START_POS = new CANNON.Vec3(0, 3, -5);
const START_QUAT = new CANNON.Quaternion();

// If the player was somewhere else when they last reloaded, resume there
// instead of always restarting at the world origin (see lib/carState.js).
// Read once at startup - it reflects wherever the *previous* session left
// off, not anything from this one.
const savedCarState = loadCarState();

function playerSpawnPos() {
  if (savedCarState) return new CANNON.Vec3(savedCarState.x, savedCarState.y, savedCarState.z);
  const offset = net.spawnOffset();
  return new CANNON.Vec3(START_POS.x + offset.x, START_POS.y, START_POS.z + offset.z);
}

function playerSpawnQuat() {
  if (!savedCarState) return START_QUAT;
  return new CANNON.Quaternion(savedCarState.qx, savedCarState.qy, savedCarState.qz, savedCarState.qw);
}

// ---------- Debug visuals (tile HUD, hitboxes) ----------
const debugVisuals = createDebugVisualsToggle(
  {
    terrain,
    buildings,
    streets,
    rivers,
    waterAreas,
    terrainStatsEl: document.getElementById('terrain-stats'),
    suspensionHudEl: document.getElementById('suspension-hud'),
    vehicleDebugHudEl: document.getElementById('vehicle-debug-hud'),
  },
  IS_DEV_MODE
);

// ---------- Car + remote players ----------
const carManager = createCarManager({ world, scene, pedestrians, debugVisuals, playerSpawnPos, startQuat: START_QUAT, playerSpawnQuat });

// ---------- Instant vehicle picker in the debug view (see M-key toggle
// above); needs net too so switches broadcast to peers like the lobby's
// picker does on join. ----------
const vehicleDebugPicker = createVehicleDebugPicker({
  carManager,
  net,
  tabsEl: document.getElementById('vehicle-debug-tabs'),
  listEl: document.getElementById('vehicle-debug-list'),
});

// ---------- Input ----------
const input = createInputController();
const collapsibleHud = setupCollapsibleHud();
setupTouchControls(input.keys);

// ---------- Camera ----------
const cameraFollow = createCameraFollow(camera);

// ---------- HUD ----------
const gaugesHud = createGaugesHud({ initialKm: savedCarState?.odoKm ?? 0 });
const terrainStatsHud = createTerrainStatsHud();
const suspensionHud = createSuspensionHud();
const playersPanel = createPlayersPanel();
const minimapHud = createMinimapHud();
createVersionBadge();

// ---------- Address search / personal teleport ----------
const addressSearch = createAddressSearch({
  terrain,
  buildings,
  streets,
  rivers,
  waterAreas,
  carManager,
  origin: { lat: ORIGIN_LAT, lon: ORIGIN_LON },
  isJoined: () => lobby.isJoined(),
});

// ---------- Gameplay props (pedestrians + balls) ----------
const scoreToast = createScoreToast();
const airtimeHud = createAirtimeHud();
const shots = createShots({
  scene,
  world,
  onCarHit() {
    carManager.addScore(SCORE_PER_CAR_HIT);
    scoreToast.push(SCORE_PER_CAR_HIT, 'car');
  },
});
const horn = createHorn();
const jump = createJump({ world });
createMusic();
setupGameplayProps({
  pedestrians,
  balls,
  shots,
  net,
  carManager,
  scoreToast,
});
const scoring = createScoring({
  world,
  carManager,
  onJumpScore: (points) => scoreToast.push(points, 'jump'),
  onAirtimeUpdate: (points) => airtimeHud.update(points),
  onAirtimeEnd: () => airtimeHud.hide(),
});

// ---------- Main loop ----------
let loopStarted = false;
const mainLoop = createMainLoop({
  world,
  scene,
  camera,
  renderer,
  sun,
  SUN_OFFSET,
  terrain,
  buildings,
  streets,
  rivers,
  waterAreas,
  balls,
  pedestrians,
  shots,
  horn,
  jump,
  remoteCollisions,
  net,
  input,
  carManager,
  cameraFollow,
  gaugesHud,
  terrainStatsHud,
  suspensionHud,
  playersPanel,
  minimapHud,
  debugVisuals,
  addressSearch,
  preventGroundTunneling,
  buildingTunnelGuard,
  preventBuildingEmbedding,
  scoring,
  isJoined: () => lobby.isJoined(),
});

function startLoopOnce() {
  if (loopStarted) return;
  loopStarted = true;
  mainLoop.animate();
}

// ---------- Lobby (name/color + join flow) ----------
const lobby = createLobby({
  net,
  carManager,
  originChain: () => addressSearch.awaitOriginChain(),
  onJoined(color, vehicleId) {
    carManager.spawnLocalCar(color, vehicleId);
    vehicleDebugPicker.syncFromCar();
    addressSearch.setUiEnabled(true);
    startLoopOnce();
    // Only start the help/players auto-fold timers once the player has
    // actually joined (name/color picked) - starting them at page load
    // would risk folding the help panel away while they're still on the
    // lobby form (see hud/collapsible.js).
    collapsibleHud.startAutoFold();
  },
  onReset() {
    // applyLivePick() in lobby.js already respawned the car with the
    // newly-picked color/vehicle - just re-sync the debug view's vehicle
    // picker so it doesn't disagree with the new choice.
    vehicleDebugPicker.syncFromCar();
  },
});

// ---------- Startup ----------
// Load the initial terrain around the spawn point before starting the sim,
// so the car never falls through an unloaded world. Buildings stream in
// via the same per-frame animate() call once the car exists - not awaited
// here, since building tiles are slower/less critical than the aerial/
// elevation tile sources and terrain-only is enough to safely start
// driving.
terrain.init().then(() => {
  loadingEl.remove();
  if (IS_DEV_MODE) {
    // Skip the name/color prompt and preview car entirely in dev -
    // joinRoom() spawns the (only) car and starts the loop itself.
    lobby.joinRoom('dev_mode', DEFAULT_BODY_COLOR);
    return;
  }
  // If the player already picked a name/color on a previous visit, skip
  // the prompt entirely and join straight away with those saved choices.
  if (lobby.tryAutoJoin()) return;
  lobby.enableJoinButton();
  lobby.setStatus('Enter your name and pick a color.');
  carManager.spawnPreviewCar(START_POS);
  startLoopOnce();
});
