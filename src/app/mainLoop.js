import * as THREE from 'three';
import { lon2tileX, lat2tileY } from '../lib/geo.js';
import { DETAIL_ZOOM } from '../lib/terrain.js';
import { FIXED_STEP, MAX_SUBSTEPS, STREAMING_BUDGET_MS, AMBIENT_TEMP_C } from '../config.js';
import { createFrameBudget, Tier } from './frameBudget.js';
import { createHitchProfiler } from './hitchProfiler.js';
import { saveCarState } from '../lib/carState.js';
import { getVehicleOdometerKm, setVehicleOdometerKm } from '../lib/vehicleOdometers.js';
import { classifySurfaceAt } from '../lib/terrainSurface.js';
import { getVehicle as getVehicleDescriptor } from '../lib/vehicles/index.js';
import { setCarListener, setWheelStereo } from '../lib/audio/audioContext.js';
import { getCameraView } from './cameraViews/index.js';

// Own-car sounds play at full volume within this camera distance (covers the
// default chase view), then fall off as 1/distance.
const CAR_SOUND_FULL_DISTANCE_M = 40;
// Max stereo pan, so the car never sounds entirely in one ear.
const CAR_SOUND_MAX_PAN = 0.7;
const toCar = new THREE.Vector3();
const cameraRight = new THREE.Vector3();

/** Fades and pans the own car's sounds by where it sits relative to the camera. */
function updateCarListener(camera, carPosition) {
  toCar.subVectors(carPosition, camera.position);
  const distance = toCar.length();
  cameraRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  const pan = distance > 0.5 ? (toCar.dot(cameraRight) / distance) * CAR_SOUND_MAX_PAN : 0;
  setCarListener(Math.min(1, CAR_SOUND_FULL_DISTANCE_M / distance), pan);
}

const CAR_STATE_SAVE_INTERVAL_MS = 1000; // localStorage save throttle
const ODOMETER_SAVE_INTERVAL_MS = 10000;

/** Trailer orientation for the pose message ([x, y, z, w]), if the rig tows one. */
function trailerQuatOf(vehicle) {
  const q = vehicle.extraBodies?.[0]?.quaternion;
  return q ? [q.x, q.y, q.z, q.w] : undefined;
}

// Per-frame orchestration: fixed-step physics with guards and render
// interpolation, then gameplay/HUD/camera/streaming updates and network
// publishing. Only call order lives here, no logic of its own.

export function createMainLoop({
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
  tireSmoke,
  exhaustFlames,
  coolantSteam,
  rimSparks,
  terrainDust,
  wheelDebris,
  bodyDust,
  carShadows,
  dissolve,
  clouds,
  remoteCollisions,
  net,
  input,
  carManager,
  cameraFollow,
  gaugesHud,
  gearstickHud,
  cursorHide,
  terrainStatsHud,
  streamingStatus,
  suspensionHud,
  engineHud,
  tyreHud,
  bodyHud,
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
  isJoined,
  scenarioEditor,
  rallySession,
}) {
  let lastTime = performance.now();
  let accumulator = 0;
  let nextBallSend = 0;
  let nextCarStateSave = 0;
  // Latest save payload, flushed on pagehide between throttled saves.
  let pendingCarState = null;
  // Vehicle whose reading the dash odometer shows; saved on switch, pagehide and a slow throttle.
  let odometerVehicleId = null;
  let nextOdometerSave = 0;
  const saveOdometer = () => {
    if (odometerVehicleId) setVehicleOdometerKm(odometerVehicleId, gaugesHud.getOdometerKm());
  };
  window.addEventListener('pagehide', () => {
    if (pendingCarState) saveCarState(pendingCarState);
    saveOdometer();
  });
  const poseForward = new THREE.Vector3();
  const terrainHeading = new THREE.Vector3();

  // Streaming work after terrain, by priority; `at` is this frame's car position.
  const at = { dt: 0, x: 0, z: 0, tileX: 0, tileY: 0 };
  const profiler = createHitchProfiler(renderer);
  const streaming = createFrameBudget(STREAMING_BUDGET_MS, (name) => profiler.mark(`stream:${name}`));
  // Gameplay: near buildings carry the collision prisms.
  streaming.add(Tier.GAMEPLAY, 'buildings', (deadline) => buildings.update(at.tileX, at.tileY, false, deadline));
  // Overlays still fetch their data every frame (tyre grip, splash); only their debug meshes wait.
  const overlays = { streets, rivers, waterAreas, builtUpAreas, landcoverAreas };
  for (const [name, layer] of Object.entries(overlays)) {
    streaming.add(Tier.COSMETIC, name, (deadline) => layer.update(at.tileX, at.tileY, false, deadline));
  }
  for (const [name, part] of Object.entries({ roadside, trees, bushes, rocks })) {
    streaming.add(Tier.COSMETIC, name, (deadline) => part.update(at.dt, at.x, at.z, deadline));
  }
  streaming.add(Tier.COSMETIC, 'farBuildings', (deadline) => buildings.updateFar(deadline));

  function animate() {
    requestAnimationFrame(animate);
    profiler.begin();

    const now = performance.now();
    const frameDelta = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    // First, so everything below sees one consistent frame. Not during a
    // teleport: the view frame has already moved but the car hasn't.
    if (!addressSearch.isTeleporting()) floatingOrigin.update(carManager.getVehicle()?.chassisBody.position);

    const vehicle = carManager.getVehicle();
    const chassisMesh = carManager.getChassisMesh();
    const reset = carManager.getReset();
    if (vehicle?.imperfectionFrame) {
      // Surface bumps are keyed by network-frame metres (fixed per spot); the frame map is affine.
      const origin = viewFrame.toNetwork(0, 0);
      const frame = vehicle.imperfectionFrame;
      frame.ox = origin.x;
      frame.oz = origin.z;
      frame.sx = viewFrame.toNetwork(1, 0).x - origin.x;
    }

    carManager.getUpdateReset()?.(frameDelta);
    // Rally: R rocks the car instead of resetting it.
    input.updateControls(vehicle, rallySession && reset ? rallySession.rock : reset, frameDelta);
    if (vehicle?.fuel) vehicle.fuel.update(frameDelta, vehicle.engine);
    if (vehicle?.heat) vehicle.heat.update(frameDelta, vehicle.engine, vehicle.chassisBody.velocity.length(), AMBIENT_TEMP_C);
    jump.update(frameDelta, fireAndJump && !!vehicle && !input.isTyping() && !input.isLocked() && input.keys.has('KeyJ'), vehicle);

    // Network messages use the fixed network frame; remap them into this
    // player's view frame (viewFrame.js), and ours back before publishing.
    function toViewFrame(pose) {
      return { ...pose, ...viewFrame.fromNetwork(pose.x, pose.z) };
    }
    function toNetworkFrame(pose) {
      return { ...pose, ...viewFrame.toNetwork(pose.x, pose.z) };
    }

    profiler.mark('input');
    const remotePoses = isJoined() ? net.remotePoses(now).map(toViewFrame) : [];

    // Remote cars are kinematic obstacles; place them before the step.
    if (isJoined()) remoteCollisions.sync(remotePoses);
    // Building colliders follow the car; before the step, so a fresh spawn already has them.
    if (vehicle && !addressSearch.isTeleporting()) {
      buildings.setPhysicsCenter(vehicle.chassisBody.position.x, vehicle.chassisBody.position.z);
    }

    // Fixed-size steps (accumulator) + interpolated rendering: a varying
    // substep count per frame would show as jitter.
    // Paused during a teleport: the old ground is gone and the new one is
    // still loading, so the ground guard would rescue the car to the start.
    if (!addressSearch.isTeleporting()) accumulator += frameDelta;
    let substeps = 0;
    while (accumulator >= FIXED_STEP && substeps < MAX_SUBSTEPS) {
      buildingTunnelGuard.beforeStep(carManager.getVehicle());
      world.step(FIXED_STEP);
      preventGroundTunneling(carManager.getVehicle());
      buildingTunnelGuard.afterStep(carManager.getVehicle());
      const snapshotPhysics = carManager.getSnapshotPhysics();
      if (snapshotPhysics) snapshotPhysics();
      pedestrians.flushHits();
      shots.flushHits();
      rallySession?.afterStep(FIXED_STEP);
      accumulator -= FIXED_STEP;
      substeps++;
    }
    // Lagging badly: drop the remainder instead of spiralling.
    if (accumulator > FIXED_STEP) accumulator = accumulator % FIXED_STEP;
    profiler.mark('physics');

    const alpha = accumulator / FIXED_STEP;
    const syncMeshes = carManager.getSyncMeshes();
    if (syncMeshes) syncMeshes(alpha);
    balls.syncMeshes();
    pedestrians.syncMeshes(frameDelta);
    shots.update(frameDelta);

    const currentChassisMesh = carManager.getChassisMesh();
    const currentVehicle = carManager.getVehicle();
    const hornLevel = horn.update(
      frameDelta,
      isJoined() && !!currentVehicle && !input.isTyping() && input.keys.has('KeyH'),
      currentChassisMesh?.position,
      remotePoses
    );
    const lightsOn = headlightSwitch.update(
      !!currentVehicle && !input.isTyping() && input.keys.has('KeyL'),
      daylight.getSunElevation()
    );
    if (isJoined() && currentChassisMesh && currentVehicle) {
      if (fireAndJump && !input.isTyping() && !input.isLocked()) {
        const shot = shots.tryFire(currentVehicle.chassisBody, input.keys.has('KeyF'));
        if (shot) net.publishProps({ type: 'shot', ...toNetworkFrame(shot) });
      }
      scoring.update(frameDelta, currentChassisMesh, currentVehicle);
      pedestrians.updatePopulation(
        currentChassisMesh.position.x,
        currentChassisMesh.position.y,
        currentChassisMesh.position.z
      );
      pedestrians.updateNearMisses(
        currentChassisMesh.position.x,
        currentChassisMesh.position.z,
        currentVehicle.chassisBody.velocity.x,
        currentVehicle.chassisBody.velocity.z
      );
      poseForward.set(0, 0, 1).applyQuaternion(currentChassisMesh.quaternion);
      const velocity = currentVehicle.chassisBody.velocity;
      const { x: netX, z: netZ } = viewFrame.toNetwork(currentChassisMesh.position.x, currentChassisMesh.position.z);
      net.publishPose({
        x: netX,
        y: currentChassisMesh.position.y,
        z: netZ,
        qx: currentChassisMesh.quaternion.x,
        qy: currentChassisMesh.quaternion.y,
        qz: currentChassisMesh.quaternion.z,
        qw: currentChassisMesh.quaternion.w,
        speed: velocity.x * poseForward.x + velocity.y * poseForward.y + velocity.z * poseForward.z,
        steer: currentVehicle.steerInput ?? currentVehicle.wheelInfos[0]?.steering ?? 0,
        trailerQuat: trailerQuatOf(currentVehicle),
        score: carManager.getScore(),
        horn: hornLevel,
        lights: lightsOn,
      });
      if (now >= nextBallSend) {
        nextBallSend = now + 100;
        for (const pose of balls.ownedPoses()) net.publishProps({ type: 'ball', ...toNetworkFrame(pose) });
      }
      carManager.updateRemotes(frameDelta, remotePoses);

      // Fresh every frame (for pagehide); written on the throttle below.
      pendingCarState = {
        x: netX,
        y: currentChassisMesh.position.y,
        z: netZ,
        qx: currentChassisMesh.quaternion.x,
        qy: currentChassisMesh.quaternion.y,
        qz: currentChassisMesh.quaternion.z,
        qw: currentChassisMesh.quaternion.w,
        odoKm: gaugesHud.getTripKm(),
        score: carManager.getScore(),
        handbrakeLatched: input.getHandbrake().latched,
        fuel: carManager.getFuelState(),
        tyres: carManager.getTyreState(),
        heat: carManager.getHeatState(),
        damage: carManager.getDamageState(),
      };
      if (now >= nextCarStateSave) {
        nextCarStateSave = now + CAR_STATE_SAVE_INTERVAL_MS;
        saveCarState(pendingCarState);
      }
      if (now >= nextOdometerSave) {
        nextOdometerSave = now + ODOMETER_SAVE_INTERVAL_MS;
        saveOdometer();
      }
    }

    profiler.mark('gameplay');
    cameraFollow(frameDelta, {
      chassisMesh: currentChassisMesh,
      podMesh: carManager.getPodMesh(),
      vehicle: currentVehicle,
      vehicleId: carManager.getVehicleId(),
      teleporting: addressSearch.isTeleporting(),
      resetting: carManager.isResetting(),
    });
    setWheelStereo(!!getCameraView(cameraFollow.getViewId()).wheelStereo);
    if (currentChassisMesh) updateCarListener(camera, currentChassisMesh.position);
    if (currentVehicle && carManager.getVehicleId() !== odometerVehicleId) {
      saveOdometer();
      odometerVehicleId = carManager.getVehicleId();
      gaugesHud.setOdometerKm(getVehicleOdometerKm(odometerVehicleId));
    }
    gaugesHud.updateGauges(currentChassisMesh, currentVehicle, input.getHandbrake(), lightsOn, input.getGearMode(), input.getTransmission());
    gaugesHud.updateHubLight(camera, daylight.getLight());
    gearstickHud.update(frameDelta, { vehicle: currentVehicle, keys: input.keys, typing: input.isTyping() });
    cursorHide.update(currentVehicle ? currentVehicle.chassisBody.velocity.length() : null);
    headlights.update(frameDelta, {
      chassisMesh: currentChassisMesh,
      wheeled: currentVehicle?.vehicleType !== 'hover',
      on: lightsOn,
      braking: input.isBraking(),
      reversing: currentVehicle?.engine?.gear === 0,
      damage: currentVehicle?.lamps?.broken,
      remotes: carManager.getRemoteLights(headlightSwitch.isNight()),
    });
    carShadows.update(carManager.getShadowCasters());
    const debugVisualsEnabled = debugVisuals.isEnabled();
    terrainStatsHud.updateTerrainStats(frameDelta, {
      terrain,
      buildings,
      streets,
      rivers,
      waterAreas,
      builtUpAreas,
      chassisMesh: currentChassisMesh,
      debugVisualsEnabled,
      pedestrians,
      viewFrame,
      roadside,
      trees,
      bushes,
      rocks,
    });
    streamingStatus.update(frameDelta, {
      terrain,
      buildings,
      streets,
      rivers,
      waterAreas,
      builtUpAreas,
      landcoverAreas,
      roadside,
      trees,
      bushes,
      rocks,
    });
    // Wheel surface for the next physics steps' tyre grip (one frame lag).
    if (currentVehicle) {
      for (const wheel of currentVehicle.wheelInfos) {
        const pos = wheel.worldTransform.position;
        wheel.surface = classifySurfaceAt(pos.x, pos.z, { streets, waterAreas, rivers, landcoverAreas, builtUpAreas });
      }
    }
    // Water depth for the next physics steps' hull drag + visual sink (next frame's syncMeshes).
    waterImmersion.update(frameDelta, currentVehicle);
    suspensionHud.updateSuspensionHud(currentVehicle, debugVisualsEnabled, scoring.isLanded(), world, {
      streets,
      waterAreas,
      rivers,
      landcoverAreas,
      builtUpAreas,
    });
    engineHud.updateEngineHud(currentVehicle, debugVisualsEnabled);
    tyreHud.updateTyreHud(currentVehicle, debugVisualsEnabled);
    bodyHud.updateBodyHud(currentVehicle, debugVisualsEnabled);
    // Effects run regardless of debug state. Splash also takes streets
    // (bridges don't splash) and rivers (narrow waterways).
    splash.update(frameDelta, currentVehicle, world, waterAreas, streets, rivers);
    tireSmoke.update(frameDelta, currentVehicle, world);
    rimSparks.update(frameDelta, currentVehicle, world);
    exhaustFlames.update(frameDelta, currentVehicle, currentChassisMesh, getVehicleDescriptor(carManager.getVehicleId()));
    coolantSteam.update(frameDelta, currentVehicle, currentChassisMesh);
    tireSqueal.update(currentVehicle);
    gravelSpinSound.update(currentVehicle);
    bodyScrapeSound.update(frameDelta);
    suspensionThud.update(frameDelta, currentVehicle);
    engineSound.update(currentVehicle, getVehicleDescriptor(carManager.getVehicleId()), input.getThrottle());
    terrainDust.update(frameDelta, currentVehicle, world);
    wheelDebris.update(frameDelta, currentVehicle, world);
    // Body dust is spawned by collide events; this only ages puffs.
    bodyDust.update(frameDelta);
    dissolve.update(frameDelta);
    if (currentChassisMesh) {
      clouds.update(frameDelta, currentChassisMesh.position.x, currentChassisMesh.position.z, currentChassisMesh.position.y);
    }
    playersPanel.updatePlayersPanel(frameDelta, { net, carManager, isJoined });
    profiler.mark('hud+effects');

    if (currentChassisMesh) {
      const { lat: carLat, lon: carLon } = viewFrame.toLatLon(
        currentChassisMesh.position.x,
        currentChassisMesh.position.z
      );
      daylight.update(currentChassisMesh.position, carLat, carLon);
      streetLights.update(frameDelta, currentChassisMesh.position, daylight.getSunElevation());
      routeGuidance.update(carLat, carLon);

      // Stream around the car, but not during a teleport: the origin has
      // already moved while the car hasn't, so tile math would be bogus.
      if (!addressSearch.isTeleporting()) {
        // Facing prioritizes LOW-ring terrain tiles ahead of the car.
        terrainHeading.set(0, 0, 1).applyQuaternion(currentChassisMesh.quaternion);
        terrain.update(currentChassisMesh.position.x, currentChassisMesh.position.z, false, {
          x: terrainHeading.x,
          z: terrainHeading.z,
        });
        profiler.mark('terrain');

        // Same DETAIL_ZOOM tile centre as TerrainManager computes.
        at.tileX = Math.floor(lon2tileX(carLon, DETAIL_ZOOM));
        at.tileY = Math.floor(lat2tileY(carLat, DETAIL_ZOOM));
        at.dt = frameDelta;
        at.x = currentChassisMesh.position.x;
        at.z = currentChassisMesh.position.z;
        streaming.run();
        places.update(carLat, carLon);
        const headingLen = Math.hypot(terrainHeading.x, terrainHeading.z) || 1;
        directionSignHud.update(
          frameDelta,
          roadside.standing('directionSigns'),
          currentChassisMesh.position.x,
          currentChassisMesh.position.z,
          terrainHeading.x / headingLen,
          terrainHeading.z / headingLen
        );
      }
      // Lift a car found inside a building onto its roof.
      preventBuildingEmbedding(currentVehicle);

      minimapHud.update(currentChassisMesh, viewFrame, remotePoses);
    }
    scenarioEditor?.update();
    rallySession?.update(frameDelta);
    profiler.mark('misc');

    renderView();
    profiler.mark('render');
    profiler.end();
  }

  return { animate, setStreamingBudgetMs: streaming.setBudgetMs };
}
