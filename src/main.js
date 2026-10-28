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
import { createExhaustFlames } from './lib/exhaustFlames.js';
import { createExhaustPipes } from './lib/exhaustPipes.js';
import { createCoolantSteam } from './lib/coolantSteam.js';
import { createBrakeSteam } from './lib/brakeSteam.js';
import { createRimSparks } from './lib/rimSparks.js';
import { createTerrainDust } from './lib/terrainDust.js';
import { createBodyDust } from './lib/bodyDust.js';
import { createCarShadows } from './lib/carShadow.js';
import { createWheelDebris } from './lib/wheelDebris.js';
import { createWetSpray } from './lib/wetSpray.js';
import { createRain } from './lib/rain.js';
import { createDissolve } from './lib/dissolve.js';
import { createClouds } from './lib/clouds.js';
import { createMusic } from './lib/audio/music.js';
import { createVolumeSliders } from './lib/audio/volumeSliders.js';
import { createGraphicsDetailPicker } from './ui/graphicsDetailPicker.js';
import { createGameplaySettings } from './ui/gameplaySettings.js';
import { createGraphicsToggles } from './ui/graphicsToggles.js';
import { createEngineSound } from './lib/audio/engine.js';
import { createTireSqueal } from './lib/audio/tireSqueal.js';
import { createWaterWadeSound } from './lib/audio/waterWade.js';
import { createGravelSpinSound } from './lib/audio/gravelSpin.js';
import { createBodyScrapeSound } from './lib/audio/bodyScrape.js';
import { createImpactSound } from './lib/audio/impact.js';
import { createPostHitSound } from './lib/audio/postHit.js';
import { createPedestrianSounds } from './lib/audio/pedestrian.js';
import { createSuspensionThud } from './lib/audio/suspensionThud.js';
import { createTyrePopSound } from './lib/audio/tyrePop.js';
import { createRimGrindSound } from './lib/audio/rimGrind.js';
import { createHandbrakeSound } from './lib/audio/handbrake.js';
import { createLightSwitchSound } from './lib/audio/lightSwitch.js';
import { createGearShiftSound } from './lib/audio/gearShift.js';
import { createSparklePop } from './lib/audio/sparklePop.js';
import { createRepairTool } from './lib/audio/repairTool.js';
import { createBackfireSound } from './lib/audio/backfire.js';
import { createCoolantHissSound } from './lib/audio/coolantHiss.js';
import { createStartBeep } from './lib/audio/startBeep.js';
import { createHeadlights } from './lib/headlights.js';
import { createHeadlightSwitch } from './app/headlightSwitch.js';
import { BuildingsManager } from './lib/buildings.js';
import { StreetsManager, setRoadOvercast } from './lib/streets.js';
import { RiversManager } from './lib/rivers.js';
import { createRoadside } from './lib/roadside.js';
import { createCurbs } from './lib/curbs.js';
import { createRoadPostKind } from './lib/roadPosts.js';
import { createGuardRailKind } from './lib/guardRails.js';
import { createRoadSignKinds } from './lib/roadSigns.js';
import { createStreetLampKind } from './lib/streetLamps.js';
import { createStreetLights } from './lib/streetLights.js';
import { addSignGlints } from './lib/signGlints.js';
import { createDirectionSignKind } from './lib/directionSigns.js';
import { createPlaces } from './lib/places.js';
import { createDirectionSignHud } from './hud/directionSignHud.js';
import { WaterAreasManager } from './lib/waterAreas.js';
import { BuiltUpAreasManager } from './lib/builtUpAreas.js';
import { LandcoverAreasManager } from './lib/landcoverAreas.js';
import { createTrees, createBushes, createRocks } from './lib/trees.js';
import { loadCarState, setCarStateSaving } from './lib/carState.js';
import { loadOrCreatePlayerId } from './lib/playerId.js';
import { restoreCloudSave, createCloudSave } from './lib/cloudSave.js';
import { migrateStoredVehicleIds } from './lib/vehicleIdMigration.js';

import { ORIGIN_LAT, ORIGIN_LON, IS_DEV_MODE, SCORE_PER_CAR_HIT, SCORING_ENABLED, LEGACY_GITHUB_TOKEN_STORAGE_KEY, MINIMAP_RALLY_DEFAULT_ZOOM, MINIMAP_STORAGE_KEY } from './config.js';
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
import { createCursorHide } from './app/cursorHide.js';
import { createTerrainStatsHud } from './hud/terrainStatsHud.js';
import { createSuspensionHud } from './hud/suspensionHud.js';
import { createEngineHud } from './hud/engineHud.js';
import { createTyreHud } from './hud/tyreHud.js';
import { createBodyHud } from './hud/bodyHud.js';
import { createBrakeHud } from './hud/brakeHud.js';
import { createMinimapHud } from './hud/minimap.js';
import { createPlayersPanel } from './hud/playersPanel.js';
import { setupCollapsibleHud } from './hud/collapsible.js';
import { setupDebugFolds } from './hud/debugFold.js';
import { setupDebugHudWrap } from './hud/debugHudWrap.js';
import { setupTouchControls } from './hud/touchControls.js';
import { createDebugVisualsToggle } from './hud/debugVisuals.js';
import { createTimeOfDayPicker } from './hud/timeOfDayPicker.js';
import { createWeatherDebug } from './hud/weatherDebug.js';
import { createWeatherFeed } from './app/weatherFeed.js';
import { getCloudPreset, onWeatherChange } from './lib/weather.js';
import { createSurfaceHover } from './hud/surfaceHover.js';
import { createRoadBedInspect } from './hud/roadBedInspect.js';
import { createVehicleDebugPicker, loadDevCarChoice } from './hud/vehicleDebugPicker.js';
import { createVersionBadge } from './hud/versionBadge.js';
import { createFpsCounter } from './hud/fpsCounter.js';
import { createFpsGraph } from './hud/fpsGraph.js';
import { createAddressSearch } from './ui/addressSearch.js';
import { createNavigationPanel } from './ui/navigationPanel.js';
import { createRouteGuidance } from './app/routeGuidance.js';
import { createViewFrame } from './app/viewFrame.js';
import { createFloatingOrigin } from './app/floatingOrigin.js';
import { createDaylight } from './app/daylight.js';
import { createLobby, loadProfileName, loadProfileVehicleId } from './ui/lobby.js';
import { createMainMenu, reloadToMenu } from './ui/mainMenu.js';
import { getActiveModeId, getActiveStartId, isEditorSession, readSaveField, writeSaveField } from './lib/saves.js';
import { getVehicleColor } from './lib/vehicleColors.js';
import { getGameMode, keepsProgress as gameKeepsProgress } from './app/gameModes.js';
import { SCENARIO_FORMATS } from './lib/scenarios/formats.js';
import { createScenarioEditor } from './app/scenarioEditor.js';
import { createEditorPanel } from './ui/editorPanel.js';
import { createEditorNotePicking } from './app/editorNotePicking.js';
import { createPacenotePanel } from './ui/pacenotePanel.js';
import { createSurfacePanel } from './ui/surfacePanel.js';
import { createCourseObjectsPanel } from './ui/courseObjectsPanel.js';
import { createRallySession, pickPlan, planStart } from './app/rally/rallySession.js';
import { createRallyPicker } from './ui/rallyPicker.js';
import { createScreenFade } from './ui/screenFade.js';
import { createTyreServiceDialog } from './ui/tyreServiceDialog.js';
import { createRoadsideRepair } from './app/roadsideRepair.js';
import { createRefuelDialog } from './ui/refuelDialog.js';
import { createRallyInfoDialog } from './ui/rallyInfoDialog.js';
import { createServiceDialog } from './ui/serviceDialog.js';
import { carParts } from './lib/serviceRepairs.js';
import { createGarageDialog } from './ui/garageDialog.js';
import { sameTyreSetup, sameRims } from './lib/tyres/setup.js';
import { getVehicle as getVehicleDescriptor } from './lib/vehicles/index.js';

// ---------- Composition root ----------
// Wires modules together in order; the logic lives in ./app, ./hud, ./ui, ./lib.

// ---------- Networking ----------
// Stable clientId across reloads, so a refresh isn't a new peer.
const playerId = loadOrCreatePlayerId();
const net = createNet({ clientId: playerId });

// ---------- Cloud save ----------
// Before anything reads the profile or the save slots: a newer backup replaces them.
await restoreCloudSave(playerId);
migrateStoredVehicleIds();
const cloudSave = createCloudSave(playerId);

// ---------- Lobby (name/color + join flow) ----------
// Before the menu: first-time players set their name there. Its callbacks run after the world is up.
const lobby = createLobby({
  net,
  getCarManager: () => carManager,
  originChain: () => addressSearch.awaitOriginChain(),
  onJoined(color, vehicleId) {
    carManager.spawnLocalCar(color, vehicleId);
    roadside.warmUp(renderer, camera);
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

// Editor saves go through the worker now: don't keep a personal token around.
try {
  localStorage.removeItem(LEGACY_GITHUB_TOKEN_STORAGE_KEY);
} catch {
  // Storage unavailable: nothing stored either.
}

// ---------- Main menu ----------
// Settings controls first: the menu's Settings screen shows them before the world loads.
createVolumeSliders();
const graphicsDetailPicker = createGraphicsDetailPicker();
const gameplaySettings = createGameplaySettings();
const graphicsToggles = createGraphicsToggles();
// Picks the game mode, and so the save slot everything below resumes from.
const mainMenu = createMainMenu({ ensureProfile: lobby.ensureProfile, settingsBodyEl: document.getElementById('hud-body') });
await mainMenu.waitForLaunch();

// ---------- Rally: first pick before the world ----------
// Car + stage are chosen first, so terrain streams in at the stage, not where the last session ended.
// menuPark (set once the world is up) parks the car while the picker covers the game.
let menuPark = null;
const isRallyGame = getActiveModeId() === 'rally' && !isEditorSession();
const isFreeRoam = getActiveModeId() === 'freeRoam' && !isEditorSession();
// Starts that don't save (e.g. a single stage) keep only the car pick.
const keepsProgress = isEditorSession() || gameKeepsProgress(getGameMode(getActiveModeId()), getActiveStartId());
if (!keepsProgress) {
  setCarStateSaving(false);
  writeSaveField('carState', null);
  writeSaveField('rallyProgress', null);
}
const rallyPicker = isRallyGame ? createRallyPicker({ playerId, onOpen: () => menuPark?.onOpen(), onClose: () => menuPark?.onClose() }) : null;
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
const { renderer, scene, camera, renderView, colorGrade } = createSceneEnvironment();
const daylight = createDaylight({ scene, ...createLighting(scene), onFog: (share) => colorGrade?.setFog(share) });
// Free roam runs on the real time of day; other modes keep the fast cycle (or their own clock, rally).
if (isFreeRoam) daylight.setClock(Date.now);
const weatherFeed = createWeatherFeed();

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
const trees = createTrees({ scene, world, terrain, landcoverAreas, streets, waterAreas, rivers, dissolve });
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
const tyrePopSound = createTyrePopSound();
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
const curbs = createCurbs({ scene, world, streets, builtUpAreas, terrain });
const streetLights = createStreetLights({ scene, terrain, roadside, lampKind: streetLampKind });
addSignGlints(roadside);
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

// Wheel effects the layers panel can switch off.
const terrainDust = createTerrainDust(scene);
const wheelDebris = createWheelDebris(scene);
const wetSpray = createWetSpray(scene);
const rain = createRain(scene);

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
    terrainDust,
    wheelDebris,
    wetSpray,
    terrainStatsEl: document.getElementById('terrain-stats'),
    fpsGraphEl: document.getElementById('fps-graph-panel'),
    suspensionHudEl: document.getElementById('suspension-hud'),
    engineHudEl: document.getElementById('engine-hud'),
    tyreHudEl: document.getElementById('tyre-hud'),
    bodyHudEl: document.getElementById('body-hud'),
    brakeHudEl: document.getElementById('brake-hud'),
    vehicleDebugHudEl: document.getElementById('vehicle-debug-hud'),
    layersHudEl: document.getElementById('debug-layers-hud'),
    roadside,
    curbs,
    directionSignHud,
    settingToggles: [
      { label: 'Road surface (Settings)', toggle: graphicsToggles.roadSurface },
      { label: 'Car dirt (Settings)', toggle: graphicsToggles.carDirt },
    ],
  },
  IS_DEV_MODE
);
createTimeOfDayPicker(document.querySelector('#debug-layers-hud .debug-time-list'), daylight);
createWeatherDebug(document.getElementById('debug-layers-hud'), weatherFeed);
setupDebugFolds(
  ['suspension-hud', 'tyre-hud', 'body-hud', 'brake-hud', 'engine-hud', 'vehicle-debug-hud', 'debug-layers-hud', 'fps-graph-panel', 'terrain-stats'].map((id) => document.getElementById(id))
);
setupDebugHudWrap(
  document.getElementById('debug-hud-row'),
  ['pacenote-panel', 'surface-panel', 'course-objects-panel', 'suspension-hud', 'tyre-hud', 'body-hud', 'brake-hud', 'engine-hud', 'vehicle-debug-hud', 'debug-layers-hud'].map(
    (id) => document.getElementById(id)
  ),
  document.getElementById('minimap')
);
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
const carShadows = createCarShadows(world, scene);
const rimSparks = createRimSparks(scene, { onGrind: createRimGrindSound().update });
const exhaustPipes = createExhaustPipes(scene, world, { onScrape: createRimGrindSound().update });
const carManager = createCarManager({
  world,
  scene,
  pedestrians,
  debugVisuals,
  bodyDust,
  bodyScrapeSound,
  impactSound,
  tyrePopSound,
  rimSparks,
  playerSpawnPos,
  startQuat: START_QUAT,
  playerSpawnQuat,
  initialFuel: savedCarState?.fuel ?? null,
  initialTyres: savedCarState?.tyres ?? null,
  initialHeat: savedCarState?.heat ?? savedCarState?.coolant ?? null,
  initialBrakes: savedCarState?.brakes ?? null,
  initialDamage: savedCarState?.damage ?? null,
  repairOnReset: !isFreeRoam,
  refillWhenEmpty: !isFreeRoam,
  noDamage: isEditorSession(),
});
carManager.addScore(savedCarState?.score ?? 0);

// ---------- Debug-view vehicle picker (pre-loaded with the saved dev pick) ----------
const devCarChoice = IS_DEV_MODE ? loadDevCarChoice() : null;
const vehicleDebugPicker = createVehicleDebugPicker({
  carManager,
  net,
  tabsEl: document.getElementById('vehicle-debug-tabs'),
  listEl: document.getElementById('vehicle-debug-list'),
  colorEl: document.getElementById('vehicle-debug-color'),
  tyresEl: document.getElementById('vehicle-debug-tyres'),
  initialVehicleId: devCarChoice?.vehicleId,
});

// ---------- Input ----------
const handbrakeSound = createHandbrakeSound();
const gearShiftSound = createGearShiftSound();
const input = createInputController({
  onHandbrakeLatch: () => handbrakeSound.play(3),
  onGearEvent: (type, engine) => gearShiftSound.play(type, engine.mass),
  initialHandbrakeLatched: savedCarState?.handbrakeLatched === true,
  holdLatchesHandbrake: () => !isRallyGame || gameplaySettings.rallyHandbrakeHold(),
});
const lightSwitchSound = createLightSwitchSound();
const headlightSwitch = createHeadlightSwitch({ onToggle: lightSwitchSound.play });
const headlights = createHeadlights(scene);
const collapsibleHud = setupCollapsibleHud({ folded: getActiveModeId() === 'rally' });
setupTouchControls(input.keys);

// ---------- Camera ----------
const cameraFollow = createCameraFollow(camera, {
  groundHeightAt: (x, z) => {
    const ground = terrain.surfaceHeightAt(x, z);
    const roof = buildings.roofHeightAt(x, z);
    return roof == null ? ground : Math.max(roof, ground ?? -Infinity);
  },
  terrainHeightAt: (x, z) => terrain.surfaceHeightAt(x, z),
  defaultViewId: getGameMode(getActiveModeId())?.cameraView,
});

// ---------- HUD ----------
const gaugesHud = createGaugesHud({ initialTripKm: savedCarState?.odoKm ?? 0, onLightsClick: headlightSwitch.toggle,
  onHandbrakeClick: input.latchHandbrake,
  onGearModeClick: input.toggleGearMode,
  onTransmissionClick: input.toggleTransmission,
});
const gearstickHud = createGearstickHud();
const terrainStatsHud = createTerrainStatsHud();
const streamingStatus = createStreamingStatus();
const suspensionHud = createSuspensionHud();
const engineHud = createEngineHud();
const tyreHud = createTyreHud();
const bodyHud = createBodyHud();
const brakeHud = createBrakeHud();
const playersPanel = createPlayersPanel();
function getCarLatLon() {
  const pos = carManager.getVehicle()?.chassisBody.position;
  return pos ? viewFrame.toLatLon(pos.x, pos.z) : null;
}
const routeGuidance = createRouteGuidance({ getCarLatLon });
const minimapHud = createMinimapHud({
  getRouteState: routeGuidance.getState,
  ...(isRallyGame && { defaultZoom: MINIMAP_RALLY_DEFAULT_ZOOM, storageKey: `${MINIMAP_STORAGE_KEY}.rally` }),
});
createVersionBadge();
createFpsCounter();
createFpsGraph();

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
dissolve.setActiveWhen(() => addressSearch.showsTeleportFx());
const navigationPanel = createNavigationPanel({
  addressSearch,
  getCarLatLon,
  routeGuidance,
  allowTeleport: isEditorSession() || getGameMode(getActiveModeId())?.teleport !== false,
  onSelectionChange: (selection) => minimapHud.setDestination(selection),
});

// ---------- Gameplay props (pedestrians + balls) ----------
const scoreToast = createScoreToast();
const airtimeHud = createAirtimeHud();
const shots = createShots({
  scene,
  world,
  onCarHit() {
    if (!SCORING_ENABLED) return;
    carManager.addScore(SCORE_PER_CAR_HIT);
    scoreToast.push(SCORE_PER_CAR_HIT, 'car');
  },
});
const horn = createHorn();
const jump = createJump({ world });
const fireAndJump = !isEditorSession() && getGameMode(getActiveModeId())?.fireAndJump === true;
const splash = createSplash(scene, { onWade: waterWadeSound.update });
const waterImmersion = createWaterImmersion({ streets, waterAreas, rivers });
const tireSmoke = createTireSmoke(scene);
const exhaustFlames = createExhaustFlames(scene, { onPop: createBackfireSound().play, getTips: exhaustPipes.getFlameTips });
const coolantSteam = createCoolantSteam(scene, { onLeak: createCoolantHissSound().update });
const brakeSteam = createBrakeSteam(scene);
const clouds = createClouds(scene, {
  onOvercast: (share) => {
    daylight.setOvercast(share);
    setRoadOvercast(share);
    colorGrade?.setOvercast(share);
  },
});
let cloudPreset = getCloudPreset();
clouds.setPreset(cloudPreset);
onWeatherChange(({ clouds: preset }) => {
  if (preset !== cloudPreset) clouds.setPreset((cloudPreset = preset));
});
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
  ...(SCORING_ENABLED && {
    onJumpScore: (points) => scoreToast.push(points, 'jump'),
    onAirtimeUpdate: (points) => airtimeHud.update(points),
    onAirtimeEnd: () => airtimeHud.hide(),
  }),
});

// ---------- Scenario editor (a mode's Editor button) ----------
const editorFormat = isEditorSession() ? SCENARIO_FORMATS[getActiveModeId()] : null;
const scenarioEditor = editorFormat
  ? createScenarioEditor({
      format: editorFormat,
      scene,
      world,
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
  if (editorFormat.kinds.some((kind) => kind.id === 'stage')) {
    createPacenotePanel(scenarioEditor);
    createSurfacePanel(scenarioEditor);
  }
  if (editorFormat.objectTypes) createCourseObjectsPanel(scenarioEditor);
  setupDebugFolds(['pacenote-panel', 'surface-panel', 'course-objects-panel'].map((id) => document.getElementById(id)));
  createEditorNotePicking({ canvas: renderer.domElement, camera, editor: scenarioEditor });
  scenarioEditor.subscribe(() => {
    const points = scenarioEditor.mapPoints();
    minimapHud.setScenarioPoints(points);
    navigationPanel.setScenarioPoints(points);
    minimapHud.setStageRoute(scenarioEditor.mapRoute(), scenarioEditor.mapReverseRoute());
    navigationPanel.setStageRoute(scenarioEditor.mapRoute(), scenarioEditor.mapReverseRoute());
  });
}

// ---------- Menus over the game ----------
// Main menu / stage picker / rally results / service dialogs open: the handbrake is pulled, the
// car takes no keys, and the drone circles it until they close. Menus move to the left
// (html.menu-aside) and the car sits in the free space to their right.
let menusOpen = 0;
// Free space narrower than this share of the screen: the car stays centred.
const MENU_ASIDE_MIN_FREE = 0.2;
// Car this share of the way across the free space, a little towards the menu.
const MENU_ASIDE_CAR_AT = 0.4;
/** Screen x (0..1) of the car in the space right of the open menu windows, or null. */
function carBesideMenus() {
  let right = 0;
  for (const win of document.querySelectorAll('.menu-window')) {
    if (win.offsetParent) right = Math.max(right, win.getBoundingClientRect().right);
  }
  const width = window.innerWidth;
  if (!right || width - right < width * MENU_ASIDE_MIN_FREE) return null;
  return (right + (width - right) * MENU_ASIDE_CAR_AT) / width;
}
menuPark = {
  onOpen() {
    if (menusOpen++ > 0) return;
    cloudSave.push();
    input.latchHandbrake();
    input.setLocked(true);
    document.documentElement.classList.add('menu-aside');
    cameraFollow.holdView('drone', { screenX: carBesideMenus });
  },
  /** @param {{ releaseHandbrake?: boolean }} [opts] - let the handbrake off once no menu is left. */
  onClose({ releaseHandbrake = false } = {}) {
    if (menusOpen === 0 || --menusOpen > 0) return;
    if (releaseHandbrake) input.releaseHandbrake();
    input.setLocked(false);
    document.documentElement.classList.remove('menu-aside');
    cameraFollow.releaseView();
  },
};

// ---------- Garage (free roam + editors; a rally picks its car in the rally picker) ----------
// A new kind is a fresh car; the same kind keeps its wear unless the tyre setup changed.
if (!isRallyGame) {
  const garage = createGarageDialog({ onOpen: () => menuPark.onOpen(), onClose: () => menuPark.onClose({ releaseHandbrake: true }) });
  const garageBtn = document.getElementById('garage-toggle');
  garageBtn.hidden = false;
  garageBtn.addEventListener('click', async () => {
    garageBtn.blur();
    const vehicle = carManager.getVehicle();
    if (!vehicle) return;
    const pick = await garage.open(carManager.getVehicleId());
    if (!pick || carManager.getVehicle() !== vehicle) return;
    const { vehicleId, color, setup } = pick;
    if (vehicleId !== carManager.getVehicleId()) {
      carManager.setVehicleKind(vehicleId, color);
    } else {
      if (color !== carManager.getColor()) carManager.setColor(color);
      if (vehicle.tyreSetup && !sameTyreSetup(setup, vehicle.tyreSetup)) carManager.setTyreSetup(setup);
      else if (vehicle.tyreSetup && !sameRims(setup, vehicle.tyreSetup)) carManager.setRims(setup);
    }
    net.setVehicleId(vehicleId);
    net.setColor(color);
    writeSaveField('vehicle', { vehicleId, color });
    vehicleDebugPicker.syncFromCar();
  });
}

// ---------- Rally game mode ----------
// Tyre service points: fresh tyres, then the dialog shows the removed set and offers another type or size and the spares.
// A click on the tyre props (fitted: false) opens it without the free set: Fit puts one on.
const repairTool = createRepairTool();
const tyreService = isRallyGame ? createTyreServiceDialog({ onOpen: () => menuPark.onOpen(), onClose: () => menuPark.onClose({ releaseHandbrake: true }) }) : null;
async function onTyreService({ fitted = true } = {}) {
  const vehicle = carManager.getVehicle();
  const removed = vehicle?.getTyreState ? { setup: vehicle.tyreSetup, labels: vehicle.wheelLabels, wheels: vehicle.getTyreState() } : null;
  if (fitted && vehicle?.repairTyres) {
    vehicle.repairTyres();
    repairTool.play();
  }
  if (!vehicle?.tyreSetup) return;
  const { setup, spares } = await tyreService.open(carManager.getVehicleId(), removed, { fitted });
  if (carManager.getVehicle() !== vehicle) return;
  if (setup) carManager.setTyreSetup(setup);
  // The service restocks the spares (setTyreSetup may have rebuilt the car).
  if (spares != null) carManager.getVehicle()?.setSpareTyres?.(spares);
}
// Refuel points / a click on the bowser: litres to add.
const refuelDialog = isRallyGame ? createRefuelDialog({ onOpen: () => menuPark.onOpen(), onClose: () => menuPark.onClose({ releaseHandbrake: true }) }) : null;
async function onRefuel() {
  const vehicle = carManager.getVehicle();
  if (!vehicle?.fuel) return;
  const add = await refuelDialog.open({ litres: vehicle.fuel.litres, capacityL: vehicle.fuel.capacityL, fuelType: getVehicleDescriptor(carManager.getVehicleId()).fuelType });
  if (add && carManager.getVehicle() === vehicle) vehicle.fuel.setLitres(vehicle.fuel.litres + add);
}
// Service points / a click on their props: repairs picked against the visit's time budget.
// Inspect car (stopped): the same list with the field fixes.
const serviceDialog = isRallyGame ? createServiceDialog({ onOpen: () => menuPark.onOpen(), onClose: () => menuPark.onClose({ releaseHandbrake: true }) }) : null;
async function onService(zone, usedMin) {
  const vehicle = carManager.getVehicle();
  if (!vehicle) return 0;
  const actions = await serviceDialog.open(() => carParts(vehicle), { zone, usedMin });
  if (carManager.getVehicle() !== vehicle || !actions.length) return 0;
  for (const action of actions) action.apply();
  repairTool.play();
  return actions.reduce((sum, a) => sum + a.minutes, 0);
}
function onInspect({ fieldFix, penaltyApplies } = {}) {
  const vehicle = carManager.getVehicle();
  if (vehicle) serviceDialog.open(() => carParts(vehicle), { fieldFix, penaltyApplies });
}
// A click on the rally base's tents.
const rallyInfoDialog = isRallyGame ? createRallyInfoDialog({ onOpen: () => menuPark.onOpen(), onClose: () => menuPark.onClose({ releaseHandbrake: true }) }) : null;
const rallySession =
  getActiveModeId() === 'rally' && !isEditorSession()
    ? createRallySession({
        scene,
        world,
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
        onTyreService,
        onRefuel,
        onService,
        onInspect,
        onRallyInfo: (info) => rallyInfoDialog.open(info),
        canvas: renderer.domElement,
        camera,
        keepsProgress,
        playerId,
        getPlayerName: loadProfileName,
        onSparkle: createSparklePop().play,
        onRepair: repairTool.play,
        onPropHit: postHitSound.play,
        onStartBeep: createStartBeep().play,
        onStartLine: () => setRallyGearMode('sport'),
        onFinishLine: () => setRallyGearMode('comfort'),
        getTimeOfDayMs: daylight.getTimeMs,
        setClock: daylight.setClock,
        setLiveWeather: weatherFeed.setEnabled,
        onMapPoints: (points) => {
          minimapHud.setScenarioPoints(points);
          navigationPanel.setScenarioPoints(points);
        },
        onFinishHold: (held) => (held ? menuPark.onOpen() : menuPark.onClose()),
        openMainMenu: mainMenu.open,
        screenFade: createScreenFade(),
        snapCamera: cameraFollow.snap,
      })
    : null;
/** Single rally: an automatic box goes to `mode` at a stage's start / finish line. */
function setRallyGearMode(mode) {
  if (getActiveStartId() === 'rally' && !carManager.getVehicle()?.engine?.manual) input.setGearMode(mode);
}
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
  parts: [carManager, cameraFollow, gaugesHud, scoring, clouds, roadside, curbs, trees, bushes, rocks, rimSparks, exhaustPipes, wheelDebris, wetSpray, rain, streetLights, ...(rallySession ? [rallySession] : []), ...(scenarioEditor ? [scenarioEditor] : [])],
});

// ---------- Main loop ----------
let loopStarted = false;
const mainLoop = createMainLoop({
  world,
  camera,
  renderer,
  renderView,
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
  curbs,
  streetLights,
  places,
  directionSignHud,
  balls,
  pedestrians,
  shots,
  fireAndJump,
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
  carDirtEnabled: graphicsToggles.carDirt.get,
  tireSmoke,
  exhaustFlames,
  exhaustPipes,
  coolantSteam,
  brakeSteam,
  rimSparks,
  terrainDust,
  wheelDebris,
  wetSpray,
  bodyDust,
  carShadows,
  dissolve,
  clouds,
  rain,
  weatherFeed,
  remoteCollisions,
  net,
  input,
  carManager,
  cameraFollow,
  gaugesHud,
  gearstickHud,
  cursorHide: createCursorHide(),
  terrainStatsHud,
  streamingStatus,
  suspensionHud,
  engineHud,
  tyreHud,
  bodyHud,
  brakeHud,
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
  roadsideRepair: isFreeRoam ? createRoadsideRepair({ canvas: renderer.domElement, camera, getVehicle: () => carManager.getVehicle(), onRepair: repairTool.play }) : null,
});
graphicsDetailPicker.bind({ terrain, mainLoop, roadside, curbs, trees, bushes, rocks });
graphicsToggles.bind({ streets });

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
    initialViewOrigin.lon,
    loadingScreen.setGameplayProgress
  );
  loadingScreen.hide();
  mainMenu.setInGame(menuPark, () => {
    mainLoop.flushSaves();
    return cloudSave.pushNow();
  });
  if (IS_DEV_MODE) {
    // Dev: no profile; join with the rally's car (just picked or resumed), else the saved debug pick.
    const rallyVehicle = isRallyGame ? readSaveField('vehicle') : null;
    const devVehicleId = rallyVehicle?.vehicleId ?? devCarChoice?.vehicleId;
    lobby.joinRoom('dev_mode', getVehicleColor(devVehicleId), devVehicleId);
    return;
  }
  lobby.joinSaved();
});
