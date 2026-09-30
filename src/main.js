import * as CANNON from 'cannon-es';
import { createNet } from './lib/net.js';
import { createRemoteCollisions } from './lib/remoteCollisions.js';
import { TerrainManager, GROUND_COLLISION_GROUP } from './lib/terrain.js';
import { createPedestrians } from './lib/pedestrians.js';
import { createBalls } from './lib/ball.js';
import { BuildingsManager } from './lib/buildings.js';

import { ORIGIN_LAT, ORIGIN_LON, BODY_COLORS, IS_DEV_MODE } from './config.js';
import { createSceneEnvironment, createLighting } from './app/sceneSetup.js';
import { createPhysicsWorld } from './app/physicsSetup.js';
import { createGroundTunnelGuard } from './app/collisions.js';
import { createCameraFollow } from './app/cameraFollow.js';
import { createInputController } from './app/input.js';
import { createCarManager } from './app/carManager.js';
import { setupGameplayProps } from './app/gameplayProps.js';
import { createMainLoop } from './app/mainLoop.js';
import { createScoring } from './app/scoring.js';
import { createScoreToast } from './hud/scoreToast.js';
import { createAirtimeHud } from './hud/airtimeHud.js';
import { createGaugesHud } from './hud/gauges.js';
import { createTerrainStatsHud } from './hud/terrainStatsHud.js';
import { createSuspensionHud } from './hud/suspensionHud.js';
import { createPlayersPanel } from './hud/playersPanel.js';
import { createDebugVisualsToggle } from './hud/debugVisuals.js';
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
const preventGroundTunneling = createGroundTunnelGuard(world);

// ---------- Real-world terrain + 3D buildings (streamed) ----------
const terrain = new TerrainManager(scene, world, ORIGIN_LAT, ORIGIN_LON);
const buildings = new BuildingsManager(scene, world, ORIGIN_LAT, ORIGIN_LON);

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
const net = createNet();

// ---------- Car spawn point ----------
// Start a few meters back along -Z (opposite of the car's forward +Z). Y is
// a small drop height above the (roughly zeroed) terrain at the origin;
// gravity settles it onto the real ground once the chunk physics bodies
// are loaded.
const START_POS = new CANNON.Vec3(0, 3, -5);
const START_QUAT = new CANNON.Quaternion();

function playerSpawnPos() {
  const offset = net.spawnOffset();
  return new CANNON.Vec3(START_POS.x + offset.x, START_POS.y, START_POS.z + offset.z);
}

// ---------- Debug visuals (tile HUD, hitboxes) ----------
const debugVisuals = createDebugVisualsToggle(
  {
    terrain,
    buildings,
    terrainStatsEl: document.getElementById('terrain-stats'),
    suspensionHudEl: document.getElementById('suspension-hud'),
  },
  IS_DEV_MODE
);

// ---------- Car + remote players ----------
const carManager = createCarManager({ world, scene, net, pedestrians, debugVisuals, playerSpawnPos, startQuat: START_QUAT });

// ---------- Input ----------
const input = createInputController();

// ---------- Camera ----------
const cameraFollow = createCameraFollow(camera);

// ---------- HUD ----------
const gaugesHud = createGaugesHud();
const terrainStatsHud = createTerrainStatsHud();
const suspensionHud = createSuspensionHud();
const playersPanel = createPlayersPanel();

// ---------- Address search / respawn ----------
const addressSearch = createAddressSearch({
  terrain,
  buildings,
  net,
  carManager,
  origin: { lat: ORIGIN_LAT, lon: ORIGIN_LON },
  startPos: START_POS,
  startQuat: START_QUAT,
  isJoined: () => lobby.isJoined(),
  playerSpawnPos,
});

// ---------- Gameplay props (pedestrians + balls) ----------
const scoreToast = createScoreToast();
const airtimeHud = createAirtimeHud();
const gameplayProps = setupGameplayProps({
  pedestrians,
  balls,
  net,
  carManager,
  isJoined: () => lobby.isJoined(),
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
  balls,
  pedestrians,
  remoteCollisions,
  net,
  input,
  carManager,
  cameraFollow,
  gaugesHud,
  terrainStatsHud,
  suspensionHud,
  playersPanel,
  debugVisuals,
  addressSearch,
  preventGroundTunneling,
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
  onJoined(color) {
    carManager.spawnLocalCar(color);
    addressSearch.setUiEnabled(true);
    gameplayProps.setButtonsEnabled(true);
    startLoopOnce();
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
    lobby.joinRoom('dev_mode', BODY_COLORS[0]);
    return;
  }
  lobby.enableJoinButton();
  lobby.setStatus('Enter your name and pick a color.');
  carManager.spawnPreviewCar(START_POS);
  startLoopOnce();
});
