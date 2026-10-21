import * as CANNON from 'cannon-es';
import { createNet } from './lib/net.js';
import { createRemoteCollisions } from './lib/remoteCollisions.js';
import { TerrainManager, GROUND_COLLISION_GROUP } from './lib/terrain.js';
import { localToLatLon } from './lib/geo.js';
import { createPedestrians } from './lib/pedestrians.js';
import { createBalls } from './lib/ball.js';
import { createShots } from './lib/shots.js';
import { createHorn } from './lib/audio/horn.js';
import { createJump } from './lib/jump.js';
import { createSplash } from './lib/splash.js';
import { createWaterImmersion } from './lib/waterImmersion.js';
import { createTireSmoke } from './lib/tireSmoke.js';
import { createTerrainDust } from './lib/terrainDust.js';
import { createBodyDust } from './lib/bodyDust.js';
import { createDissolve } from './lib/dissolve.js';
import { createClouds } from './lib/clouds.js';
import { createMusic } from './lib/audio/music.js';
import { createVolumeSliders } from './lib/audio/volumeSliders.js';
import { createGraphicsDetailPicker } from './ui/graphicsDetailPicker.js';
import { createGithubSettings } from './ui/githubSettings.js';
import { createEngineSound } from './lib/audio/engine.js';
import { createTireSqueal } from './lib/audio/tireSqueal.js';
import { createWaterWadeSound } from './lib/audio/waterWade.js';
import { createGravelSpinSound } from './lib/audio/gravelSpin.js';
import { createBodyScrapeSound } from './lib/audio/bodyScrape.js';
import { createImpactSound } from './lib/audio/impact.js';
import { createPostHitSound } from './lib/audio/postHit.js';
import { createPedestrianSounds } from './lib/audio/pedestrian.js';
import { createSuspensionThud } from './lib/audio/suspensionThud.js';
import { createHandbrakeSound } from './lib/audio/handbrake.js';
import { createLightSwitchSound } from './lib/audio/lightSwitch.js';
import { createGearShiftSound } from './lib/audio/gearShift.js';
import { createSparklePop } from './lib/audio/sparklePop.js';
import { createStartBeep } from './lib/audio/startBeep.js';
import { createHeadlights } from './lib/headlights.js';
import { createHeadlightSwitch } from './app/headlightSwitch.js';
import { BuildingsManager } from './lib/buildings.js';
import { StreetsManager } from './lib/streets.js';
import { RiversManager } from './lib/rivers.js';
import { createRoadside } from './lib/roadside.js';
import { createRoadPostKind } from './lib/roadPosts.js';
import { createGuardRailKind } from './lib/guardRails.js';
import { createRoadSignKinds } from './lib/roadSigns.js';
import { createStreetLampKind } from './lib/streetLamps.js';
import { createStreetLights } from './lib/streetLights.js';
import { createDirectionSignKind } from './lib/directionSigns.js';
import { createPlaces } from './lib/places.js';
import { createDirectionSignHud } from './hud/directionSignHud.js';
import { WaterAreasManager } from './lib/waterAreas.js';
import { BuiltUpAreasManager } from './lib/builtUpAreas.js';
import { LandcoverAreasManager } from './lib/landcoverAreas.js';
import { createTrees, createBushes, createRocks } from './lib/trees.js';
import { loadCarState, setCarStateSaving } from './lib/carState.js';
import { loadOrCreatePlayerId } from './lib/playerId.js';

import { ORIGIN_LAT, ORIGIN_LON, IS_DEV_MODE, SCORE_PER_CAR_HIT } from './config.js';
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
import { createLoadingScreen } from './hud/loadingScreen.js';
import { loadGameplayLayers } from './app/gameplayLoad.js';
import { createStreamingStatus } from './hud/streamingStatus.js';
import { createAirtimeHud } from './hud/airtimeHud.js';
import { createGaugesHud } from './hud/gauges.js';
import { createGearstickHud } from './hud/gearstick.js';
import { createTerrainStatsHud } from './hud/terrainStatsHud.js';
import { createSuspensionHud } from './hud/suspensionHud.js';
import { createMinimapHud } from './hud/minimap.js';
import { createPlayersPanel } from './hud/playersPanel.js';
import { setupCollapsibleHud } from './hud/collapsible.js';
import { setupTouchControls } from './hud/touchControls.js';
import { createDebugVisualsToggle } from './hud/debugVisuals.js';
import { createTimeOfDayPicker } from './hud/timeOfDayPicker.js';
import { createSurfaceHover } from './hud/surfaceHover.js';
import { createRoadBedInspect } from './hud/roadBedInspect.js';
import { createVehicleDebugPicker, loadDevCarChoice } from './hud/vehicleDebugPicker.js';
import { defaultVehicleColor } from './lib/vehicleColors.js';
import { createVersionBadge } from './hud/versionBadge.js';
import { createFpsCounter } from './hud/fpsCounter.js';
import { createAddressSearch } from './ui/addressSearch.js';
import { createNavigationPanel } from './ui/navigationPanel.js';
import { createRouteGuidance } from './app/routeGuidance.js';
import { createViewFrame } from './app/viewFrame.js';
import { createFloatingOrigin } from './app/floatingOrigin.js';
import { createDaylight } from './app/daylight.js';
import { createLobby, loadProfileName, loadProfileVehicleId } from './ui/lobby.js';
import { createMainMenu, reloadToMenu } from './ui/mainMenu.js';
import { getActiveModeId, isEditorSession, readSaveField, writeSaveField } from './lib/saves.js';
import { getVehicleColor } from './lib/vehicleColors.js';
import { getGameMode } from './app/gameModes.js';
import { SCENARIO_FORMATS } from './lib/scenarios/formats.js';
import { createScenarioEditor } from './app/scenarioEditor.js';
import { createEditorPanel } from './ui/editorPanel.js';
import { createRallySession, pickPlan, planStart } from './app/rally/rallySession.js';
import { createRallyPicker } from './ui/rallyPicker.js';

// ---------- Composition root ----------
// Wires modules together in order; the logic lives in ./app, ./hud, ./ui, ./lib.

// ---------- Networking ----------
// Stable clientId across reloads, so a refresh isn't a new peer.
const net = createNet({ clientId: loadOrCreatePlayerId() });

// ---------- Lobby (name/color + join flow) ----------
// Before the menu: first-time players set their name there. Its callbacks run after the world is up.
const lobby = createLobby({
  net,
  getCarManager: () => carManager,
  originChain: () => addressSearch.awaitOriginChain(),
  onJoined(color, vehicleId) {
    carManager.spawnLocalCar(color, vehicleId);
    vehicleDebugPicker.syncFromCar();
    startLoopOnce();
    beginModeOnce();
    // Start the HUD auto-fold timers only after joining.
    collapsibleHud.startAutoFold();
  },
  onReset() {
    // lobby.js already respawned the car; just sync the debug picker.
    vehicleDebugPicker.syncFromCar();
  },
});

// ---------- Main menu ----------
// Settings controls first: the menu's Settings screen shows them before the world loads.
createVolumeSliders();
const graphicsDetailPicker = createGraphicsDetailPicker();
createGithubSettings();
// Picks the game mode, and so the save slot everything below resumes from.
const mainMenu = createMainMenu({ ensureProfile: lobby.ensureProfile, settingsBodyEl: document.getElementById('hud-body') });
await mainMenu.waitForLaunch();

// ---------- Rally: first pick before the world ----------
// Car + stage are chosen first, so terrain streams in at the stage, not where the last session ended.
// menuPark (set once the world is up) parks the car while the picker covers the game.
let menuPark = null;
const isRallyGame = getActiveModeId() === 'rally' && !isEditorSession();
// Starts outside the mode's progressStarts (e.g. a single stage) keep only the car pick.
const activeMode = getGameMode(getActiveModeId());
const keepsProgress = isEditorSession() || !activeMode?.progressStarts || activeMode.progressStarts.includes(readSaveField('start'));
if (!keepsProgress) {
  setCarStateSaving(false);
  writeSaveField('carState', null);
  writeSaveField('rallyProgress', null);
}
const rallyPicker = isRallyGame ? createRallyPicker({ onOpen: () => menuPark?.onOpen(), onClose: () => menuPark?.onClose() }) : null;
let rallyInitialPick = null;
if (isRallyGame && !(keepsProgress && readSaveField('rallyProgress'))) {
  try {
    rallyInitialPick = await pickPlan(rallyPicker, { vehicleId: readSaveField('vehicle')?.vehicleId ?? loadProfileVehicleId() ?? undefined });
    if (!rallyInitialPick) {
      reloadToMenu();
      await new Promise(() => {}); // the reload takes over; build nothing meanwhile
    }
    const { vehicleId } = rallyInitialPick;
    writeSaveField('vehicle', { vehicleId, color: getVehicleColor(vehicleId) });
  } catch (err) {
    console.warn('Rally: first pick failed, picking in game instead', err);
  }
}
const rallyStart = planStart(rallyInitialPick?.plan);

// ---------- Rendering environment ----------
const { renderer, scene, camera } = createSceneEnvironment();
const daylight = createDaylight({ scene, ...createLighting(scene) });

// ---------- View frame ----------
// Resume where the previous session left off (lib/carState.js).
const savedCarState = loadCarState();

// The saved pose is in the network frame. Far from ORIGIN (e.g. after a
// teleport), start the view frame at the car instead, as a teleport does;
// from then on floatingOrigin.js keeps local coordinates small.
const VIEW_REBASE_DISTANCE_METERS = 2000;
const initialViewOrigin = rallyStart
  ? { lat: rallyStart.lat, lon: rallyStart.lon }
  : savedCarState && Math.hypot(savedCarState.x, savedCarState.z) > VIEW_REBASE_DISTANCE_METERS
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
const buildings = new BuildingsManager(scene, world, initialViewOrigin.lat, initialViewOrigin.lon, terrain);
const dissolve = createDissolve(scene); // debug layer: what streams out on a teleport bursts into particles
terrain.dissolve = dissolve;
buildings.dissolve = dissolve;
const streets = new StreetsManager(scene, world, initialViewOrigin.lat, initialViewOrigin.lon, terrain);
const rivers = new RiversManager(scene, world, initialViewOrigin.lat, initialViewOrigin.lon, terrain);
const waterAreas = new WaterAreasManager(scene, world, initialViewOrigin.lat, initialViewOrigin.lon, terrain);
const builtUpAreas = new BuiltUpAreasManager(scene, world, initialViewOrigin.lat, initialViewOrigin.lon, terrain);
pedestrians.setBuiltUpAreas(builtUpAreas);
const landcoverAreas = new LandcoverAreasManager(scene, world, initialViewOrigin.lat, initialViewOrigin.lon, terrain);
const trees = createTrees({ scene, terrain, landcoverAreas, streets, waterAreas, rivers, dissolve });
const bushes = createBushes({ scene, terrain, landcoverAreas, streets, waterAreas, rivers });
const rocks = createRocks({ scene, world, terrain, landcoverAreas, streets, waterAreas, rivers });

const loadingScreen = createLoadingScreen(terrain, initialViewOrigin);

// ---------- Audio ----------
const engineSound = createEngineSound();
const tireSqueal = createTireSqueal();
const waterWadeSound = createWaterWadeSound();
const gravelSpinSound = createGravelSpinSound();
const bodyScrapeSound = createBodyScrapeSound();
const impactSound = createImpactSound();
const postHitSound = createPostHitSound();
const places = createPlaces();
const streetLampKind = createStreetLampKind(streets, builtUpAreas);
const roadside = createRoadside({
  scene,
  world,
  streets,
  terrain,
  kinds: [
    createRoadPostKind(streets, builtUpAreas, terrain),
    createGuardRailKind(streets, builtUpAreas, terrain),
    streetLampKind,
    ...createRoadSignKinds(streets),
    createDirectionSignKind({ streets, builtUpAreas, places }),
  ],
  onHit: postHitSound.play,
});
const streetLights = createStreetLights({ scene, terrain, roadside, lampKind: streetLampKind });
const directionSignHud = createDirectionSignHud(document.getElementById('direction-sign-hud'), {
  allowed: !isEditorSession() && getGameMode(getActiveModeId())?.directionSignHud !== false,
});
const suspensionThud = createSuspensionThud();
const pedestrianSounds = createPedestrianSounds();
pedestrians.setSoundCallbacks({
  onHit: pedestrianSounds.hit,
  onBounce: (id, speed, p) => pedestrianSounds.bounce(id, speed, camera.position.distanceTo(p)),
  onNearMiss: (id, p) => pedestrianSounds.gasp(id, camera.position.distanceTo(p)),
});

// ---------- Car spawn point ----------
// A few metres back from the origin, dropped onto the terrain.
const START_POS = new CANNON.Vec3(0, 3, -5);
const START_QUAT = new CANNON.Quaternion();

function playerSpawnPos() {
  // Rally start: the view frame is centred on the stage; rallySession then lines the car up on the road.
  if (rallyStart && !savedCarState) return new CANNON.Vec3(0, (terrain.surfaceHeightAt(0, 0) ?? 0) + 3, 0);
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
    builtUpAreas,
    landcoverAreas,
    trees,
    bushes,
    rocks,
    dissolve,
    terrainStatsEl: document.getElementById('terrain-stats'),
    suspensionHudEl: document.getElementById('suspension-hud'),
    vehicleDebugHudEl: document.getElementById('vehicle-debug-hud'),
    layersHudEl: document.getElementById('debug-layers-hud'),
    roadside,
    directionSignHud,
  },
  IS_DEV_MODE
);
createTimeOfDayPicker(document.querySelector('#debug-layers-hud .debug-time-list'), daylight);
createSurfaceHover({
  el: document.getElementById('surface-hover'),
  canvas: renderer.domElement,
  camera,
  terrain,
  layers: { streets, waterAreas, rivers, landcoverAreas, builtUpAreas },
});
createRoadBedInspect({ el: document.getElementById('road-bed-inspect'), canvas: renderer.domElement, camera, terrain });

// ---------- Car + remote players ----------
// Created before carManager: its collide listener needs it on first spawn.
const bodyDust = createBodyDust(scene, { onImpact: impactSound.play });
const carManager = createCarManager({ world, scene, pedestrians, debugVisuals, bodyDust, bodyScrapeSound, impactSound, playerSpawnPos, startQuat: START_QUAT, playerSpawnQuat });
carManager.addScore(savedCarState?.score ?? 0);

// ---------- Debug-view vehicle picker (pre-loaded with the saved dev pick) ----------
const devCarChoice = IS_DEV_MODE ? loadDevCarChoice() : null;
const vehicleDebugPicker = createVehicleDebugPicker({
  carManager,
  net,
  tabsEl: document.getElementById('vehicle-debug-tabs'),
  listEl: document.getElementById('vehicle-debug-list'),
  colorEl: document.getElementById('vehicle-debug-color'),
  initialVehicleId: devCarChoice?.vehicleId,
  initialColor: devCarChoice?.color ?? defaultVehicleColor(devCarChoice?.vehicleId),
});

// ---------- Input ----------
const handbrakeSound = createHandbrakeSound();
const gearShiftSound = createGearShiftSound();
const input = createInputController({
  onHandbrakeLatch: () => handbrakeSound.play(3),
  onGearEvent: (type, engine) => gearShiftSound.play(type, engine.mass),
  initialHandbrakeLatched: savedCarState?.handbrakeLatched === true,
});
const lightSwitchSound = createLightSwitchSound();
const headlightSwitch = createHeadlightSwitch({ onToggle: lightSwitchSound.play });
const headlights = createHeadlights(scene);
const collapsibleHud = setupCollapsibleHud();
setupTouchControls(input.keys);

// ---------- Camera ----------
const cameraFollow = createCameraFollow(camera, {
  groundHeightAt: (x, z) => {
    const ground = terrain.surfaceHeightAt(x, z);
    const roof = buildings.roofHeightAt(x, z);
    return roof == null ? ground : Math.max(roof, ground ?? -Infinity);
  },
  terrainHeightAt: (x, z) => terrain.surfaceHeightAt(x, z),
});

// ---------- HUD ----------
const gaugesHud = createGaugesHud({ initialKm: savedCarState?.odoKm ?? 0, onLightsClick: headlightSwitch.toggle,
  onGearModeClick: input.toggleGearMode,
  onTransmissionClick: input.toggleTransmission,
});
const gearstickHud = createGearstickHud();
const terrainStatsHud = createTerrainStatsHud();
const streamingStatus = createStreamingStatus();
const suspensionHud = createSuspensionHud();
const playersPanel = createPlayersPanel();
function getCarLatLon() {
  const pos = carManager.getVehicle()?.chassisBody.position;
  return pos ? viewFrame.toLatLon(pos.x, pos.z) : null;
}
const routeGuidance = createRouteGuidance({ getCarLatLon });
const minimapHud = createMinimapHud({ getRouteState: routeGuidance.getState });
createVersionBadge();
createFpsCounter();

// ---------- Address search / personal teleport ----------
const addressSearch = createAddressSearch({
  world,
  terrain,
  buildings,
  streets,
  rivers,
  waterAreas,
  builtUpAreas,
  landcoverAreas,
  carManager,
  viewFrame,
  isJoined: () => lobby.isJoined(),
});
dissolve.setActiveWhen(() => addressSearch.isTeleporting());
const navigationPanel = createNavigationPanel({
  addressSearch,
  getCarLatLon,
  routeGuidance,
  onSelectionChange: (selection) => minimapHud.setDestination(selection),
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
const splash = createSplash(scene, { onWade: waterWadeSound.update });
const waterImmersion = createWaterImmersion({ streets, waterAreas, rivers });
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

// ---------- Scenario editor (a mode's Editor button) ----------
const editorFormat = isEditorSession() ? SCENARIO_FORMATS[getActiveModeId()] : null;
const scenarioEditor = editorFormat
  ? createScenarioEditor({
      format: editorFormat,
      scene,
      terrain,
      streets,
      viewFrame,
      carManager,
      addressSearch,
      getPlayerName: loadProfileName,
    })
  : null;
if (scenarioEditor) {
  createEditorPanel(scenarioEditor, {
    title: `${getGameMode(getActiveModeId()).label} editor`,
    getPlayerName: loadProfileName,
    openSettings: mainMenu.openSettings,
  });
  scenarioEditor.subscribe(() => {
    const points = scenarioEditor.mapPoints();
    minimapHud.setScenarioPoints(points);
    navigationPanel.setScenarioPoints(points);
  });
}

// ---------- Menus over the game ----------
// Main menu / stage picker open: the handbrake is pulled and the drone circles the car until they close.
let menusOpen = 0;
menuPark = {
  onOpen() {
    if (menusOpen++ > 0) return;
    input.latchHandbrake();
    cameraFollow.holdView('drone');
  },
  onClose() {
    if (menusOpen === 0 || --menusOpen > 0) return;
    cameraFollow.releaseView();
  },
};

// ---------- Rally game mode ----------
const rallySession =
  getActiveModeId() === 'rally' && !isEditorSession()
    ? createRallySession({
        scene,
        streets,
        terrain,
        viewFrame,
        carManager,
        addressSearch,
        routeGuidance,
        picker: rallyPicker,
        initialPick: rallyInitialPick,
        getVehicleId: () => carManager.getVehicleId(),
        switchVehicle,
        parkCar: input.latchHandbrake,
        keepsProgress,
        onSparkle: createSparklePop().play,
        onStartBeep: createStartBeep().play,
      })
    : null;
/** Respawns the local car as `vehicleId` where it stands, with its saved paint. */
function switchVehicle(vehicleId) {
  const body = carManager.getVehicle()?.chassisBody;
  const pos = body?.position.clone();
  const quat = body?.quaternion.clone();
  const color = getVehicleColor(vehicleId);
  carManager.spawnLocalCar(color, vehicleId);
  if (pos) carManager.getReset()?.(new CANNON.Vec3(pos.x, pos.y + 1, pos.z), quat);
  net.setColor(color);
  net.setVehicleId(vehicleId);
  writeSaveField('vehicle', { vehicleId, color });
  vehicleDebugPicker.syncFromCar();
}
let modeBegun = false;
function beginModeOnce() {
  if (modeBegun) return;
  modeBegun = true;
  rallySession?.begin();
  // Editing starts parked, like a stage does.
  if (scenarioEditor) input.latchHandbrake();
}

// ---------- Floating origin ----------
const floatingOrigin = createFloatingOrigin({
  scene,
  world,
  camera,
  viewFrame,
  streamers: [terrain, buildings, streets, rivers, waterAreas, builtUpAreas, landcoverAreas],
  parts: [carManager, cameraFollow, gaugesHud, scoring, roadside, trees, bushes, rocks, ...(rallySession ? [rallySession] : [])],
});

// ---------- Main loop ----------
let loopStarted = false;
const mainLoop = createMainLoop({
  world,
  scene,
  camera,
  renderer,
  daylight,
  terrain,
  buildings,
  streets,
  rivers,
  waterAreas,
  builtUpAreas,
  landcoverAreas,
  trees,
  bushes,
  rocks,
  roadside,
  streetLights,
  places,
  directionSignHud,
  balls,
  pedestrians,
  shots,
  horn,
  headlights,
  headlightSwitch,
  engineSound,
  tireSqueal,
  gravelSpinSound,
  bodyScrapeSound,
  suspensionThud,
  jump,
  splash,
  waterImmersion,
  tireSmoke,
  terrainDust,
  bodyDust,
  dissolve,
  clouds,
  remoteCollisions,
  net,
  input,
  carManager,
  cameraFollow,
  gaugesHud,
  gearstickHud,
  terrainStatsHud,
  streamingStatus,
  suspensionHud,
  playersPanel,
  minimapHud,
  routeGuidance,
  debugVisuals,
  addressSearch,
  preventGroundTunneling,
  buildingTunnelGuard,
  preventBuildingEmbedding,
  scoring,
  viewFrame,
  floatingOrigin,
  isJoined: () => lobby.isJoined(),
  scenarioEditor,
  rallySession,
});
graphicsDetailPicker.bind({ terrain, mainLoop, roadside, trees, bushes, rocks });

function startLoopOnce() {
  if (loopStarted) return;
  loopStarted = true;
  mainLoop.animate();
}

// ---------- Startup ----------
// Load terrain (the car can't fall through), then the gameplay layers (grip, building
// collisions) before starting; cosmetics stream in from the main loop.
terrain.init().then(async () => {
  loadingScreen.setGameplayState('active');
  await loadGameplayLayers(
    { buildings, layers: [streets, rivers, waterAreas, builtUpAreas, landcoverAreas] },
    initialViewOrigin.lat,
    initialViewOrigin.lon
  );
  loadingScreen.hide();
  mainMenu.setInGame(menuPark);
  if (IS_DEV_MODE) {
    // Dev: no profile; join with the car picked for the rally, else the saved debug pick.
    const devVehicleId = rallyInitialPick?.vehicleId ?? devCarChoice?.vehicleId;
    const devColor = rallyInitialPick ? getVehicleColor(devVehicleId) : devCarChoice?.color ?? defaultVehicleColor(devVehicleId);
    lobby.joinRoom('dev_mode', devColor, devVehicleId);
    return;
  }
  lobby.joinSaved();
});
