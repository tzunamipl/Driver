import * as CANNON from 'cannon-es';
import { createNet } from './lib/net.js';
import { createRemoteCollisions } from './lib/remoteCollisions.js';
import { TerrainManager, GROUND_COLLISION_GROUP } from './lib/terrain.js';
import { localToLatLon } from './lib/geo.js';
import { createPedestrians } from './lib/pedestrians.js';
import { createBalls } from './lib/ball.js';
import { createShots } from './lib/shots.js';
import { createHorn } from './lib/horn.js';
import { createJump } from './lib/jump.js';
import { createSplash } from './lib/splash.js';
import { createTireSmoke } from './lib/tireSmoke.js';
import { createTerrainDust } from './lib/terrainDust.js';
import { createBodyDust } from './lib/bodyDust.js';
import { createClouds } from './lib/clouds.js';
import { createMusic } from './lib/music.js';
import { createEngineAudio } from './lib/engineAudio.js';
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
import { createVehicleDebugPicker, loadDevCarChoice } from './hud/vehicleDebugPicker.js';
import { createVersionBadge } from './hud/versionBadge.js';
import { createAddressSearch } from './ui/addressSearch.js';
import { createViewFrame } from './app/viewFrame.js';
import { createFloatingOrigin } from './app/floatingOrigin.js';
import { createLobby } from './ui/lobby.js';

// ---------- Composition root ----------
// Wires modules together in order; the logic lives in ./app, ./hud, ./ui, ./lib.

// ---------- Rendering environment ----------
const { renderer, scene, camera } = createSceneEnvironment();
const { sun, sunDisc, SUN_OFFSET } = createLighting(scene);

// ---------- View frame ----------
// Resume where the previous session left off (lib/carState.js).
const savedCarState = loadCarState();

// The saved pose is in the network frame. Far from ORIGIN (e.g. after a
// teleport), start the view frame at the car instead, as a teleport does;
// from then on floatingOrigin.js keeps local coordinates small.
const VIEW_REBASE_DISTANCE_METERS = 2000;
const initialViewOrigin =
  savedCarState && Math.hypot(savedCarState.x, savedCarState.z) > VIEW_REBASE_DISTANCE_METERS
    ? localToLatLon(savedCarState.x, savedCarState.z, ORIGIN_LAT, ORIGIN_LON)
    : { lat: ORIGIN_LAT, lon: ORIGIN_LON };
const viewFrame = createViewFrame(initialViewOrigin.lat, initialViewOrigin.lon);

// ---------- Physics world ----------
const world = createPhysicsWorld();
const remoteCollisions = createRemoteCollisions(world);
const pedestrians = createPedestrians(scene, world, GROUND_COLLISION_GROUP, viewFrame);
const balls = createBalls(scene, world);
const noticeHud = createNoticeHud();
const preventGroundTunneling = createGroundTunnelGuard(
  world,
  () => {
    // Game start position in the current view frame; where the ground
    // guard rescues a body with no terrain.
    return viewFrame.fromNetwork(0, 0);
  },
  () =>
    noticeHud.show(
      "Couldn't find any ground under your car for a while, so you've been teleported back to the starting location."
    )
);
const buildingTunnelGuard = createBuildingTunnelGuard(world);
const preventBuildingEmbedding = createBuildingEmbedGuard(world);

// ---------- Real-world terrain + 3D buildings (streamed) ----------
// Height baseline stays at ORIGIN so world y matches across clients.
const terrain = new TerrainManager(scene, world, initialViewOrigin.lat, initialViewOrigin.lon, {
  lat: ORIGIN_LAT,
  lon: ORIGIN_LON,
});
const buildings = new BuildingsManager(scene, world, initialViewOrigin.lat, initialViewOrigin.lon);
const streets = new StreetsManager(scene, world, initialViewOrigin.lat, initialViewOrigin.lon);
const rivers = new RiversManager(scene, world, initialViewOrigin.lat, initialViewOrigin.lon);
const waterAreas = new WaterAreasManager(scene, world, initialViewOrigin.lat, initialViewOrigin.lon);

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

// ---------- Audio ----------
const engineAudio = createEngineAudio(camera, [
  //{ freq: 5, pitchD: 1, pitchT: 5, variation: 10, vibration: 0.3, vibrationT: 0.1 },
  { freq: 10, pitchD: 4, pitchT: 10, variation: 20, vibration: 0, vibrationT: 0 },
  { freq: 20, pitchD: 0, pitchT: 0, variation: 20, vibration: 0, vibrationT: 0 },
  //{ freq: 30, pitchD: 20, pitchT: 1, variation: 5, vibration: 0.5, vibrationT: 4 },
  //{ freq: 20, pitchD: 40, pitchT: 1, variation: 20, vibration: 0.0, vibrationT: 0.1 },
]);

// ---------- Networking ----------
// Stable clientId across reloads, so a refresh isn't a new peer.
const net = createNet({ clientId: loadOrCreatePlayerId() });

// ---------- Car spawn point ----------
// A few metres back from the origin, dropped onto the terrain.
const START_POS = new CANNON.Vec3(0, 3, -5);
const START_QUAT = new CANNON.Quaternion();

function playerSpawnPos() {
  // Saved pose and START_POS are both network-frame positions.
  if (savedCarState) {
    const { x, z } = viewFrame.fromNetwork(savedCarState.x, savedCarState.z);
    return new CANNON.Vec3(x, savedCarState.y, z);
  }
  const offset = net.spawnOffset();
  const { x, z } = viewFrame.fromNetwork(START_POS.x + offset.x, START_POS.z + offset.z);
  return new CANNON.Vec3(x, START_POS.y, z);
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
// Created before carManager: its collide listener needs it on first spawn.
const bodyDust = createBodyDust(scene);
const carManager = createCarManager({ world, scene, pedestrians, debugVisuals, bodyDust, playerSpawnPos, startQuat: START_QUAT, playerSpawnQuat });

// ---------- Debug-view vehicle picker (pre-loaded with the saved dev pick) ----------
const devCarChoice = IS_DEV_MODE ? loadDevCarChoice() : null;
const vehicleDebugPicker = createVehicleDebugPicker({
  carManager,
  net,
  tabsEl: document.getElementById('vehicle-debug-tabs'),
  listEl: document.getElementById('vehicle-debug-list'),
  colorEl: document.getElementById('vehicle-debug-color'),
  initialVehicleId: devCarChoice?.vehicleId,
  initialColor: devCarChoice?.color,
});

// ---------- Input ----------
const input = createInputController(engineAudio);
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
  world,
  terrain,
  buildings,
  streets,
  rivers,
  waterAreas,
  carManager,
  viewFrame,
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
const splash = createSplash(scene);
const tireSmoke = createTireSmoke(scene);
const terrainDust = createTerrainDust(scene);
const clouds = createClouds(scene);
createMusic();
setupGameplayProps({
  pedestrians,
  balls,
  shots,
  net,
  carManager,
  scoreToast,
  viewFrame,
});
const scoring = createScoring({
  world,
  carManager,
  onJumpScore: (points) => scoreToast.push(points, 'jump'),
  onAirtimeUpdate: (points) => airtimeHud.update(points),
  onAirtimeEnd: () => airtimeHud.hide(),
});

// ---------- Floating origin ----------
const floatingOrigin = createFloatingOrigin({
  scene,
  world,
  camera,
  viewFrame,
  streamers: [terrain, buildings, streets, rivers, waterAreas],
  parts: [carManager, cameraFollow, gaugesHud, scoring],
});

// ---------- Main loop ----------
let loopStarted = false;
const mainLoop = createMainLoop({
  world,
  scene,
  camera,
  renderer,
  sun,
  sunDisc,
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
  splash,
  tireSmoke,
  terrainDust,
  bodyDust,
  clouds,
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
  viewFrame,
  floatingOrigin,
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
    // Start the HUD auto-fold timers only after joining.
    collapsibleHud.startAutoFold();
  },
  onReset() {
    // lobby.js already respawned the car; just sync the debug picker.
    vehicleDebugPicker.syncFromCar();
  },
});

// ---------- Startup ----------
// Load initial terrain before starting, so the car can't fall through.
// Buildings stream in from the main loop.
terrain.init().then(() => {
  loadingEl.remove();
  if (IS_DEV_MODE) {
    // Dev: skip the lobby and join with the saved debug pick, if any.
    lobby.joinRoom('dev_mode', devCarChoice?.color ?? DEFAULT_BODY_COLOR, devCarChoice?.vehicleId);
    return;
  }
  // Returning player: join straight away with the saved name/colour.
  if (lobby.tryAutoJoin()) return;
  lobby.enableJoinButton();
  lobby.setStatus('Enter your name and pick a color.');
  carManager.spawnPreviewCar(START_POS);
  startLoopOnce();
});
