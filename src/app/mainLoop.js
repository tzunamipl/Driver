import * as THREE from 'three';
import { lon2tileX, lat2tileY, localToLatLon, remapLocalOrigin } from '../lib/geo.js';
import { DETAIL_ZOOM } from '../lib/terrain.js';
import { FIXED_STEP, MAX_SUBSTEPS, ORIGIN_LAT, ORIGIN_LON } from '../config.js';
import { saveCarState } from '../lib/carState.js';
import { classifySurfaceAt } from '../lib/terrainSurface.js';

const CAR_STATE_SAVE_INTERVAL_MS = 1000; // localStorage save throttle

// Per-frame orchestration: fixed-step physics with guards and render
// interpolation, then gameplay/HUD/camera/streaming updates and network
// publishing. Only call order lives here, no logic of its own.

export function createMainLoop({
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
  isJoined,
}) {
  let lastTime = performance.now();
  let accumulator = 0;
  let nextBallSend = 0;
  let nextCarStateSave = 0;
  // Latest save payload, flushed on pagehide between throttled saves.
  let pendingCarState = null;
  window.addEventListener('pagehide', () => {
    if (pendingCarState) saveCarState(pendingCarState);
  });
  const poseForward = new THREE.Vector3();
  const terrainHeading = new THREE.Vector3();

  function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const frameDelta = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    const vehicle = carManager.getVehicle();
    const chassisMesh = carManager.getChassisMesh();
    const reset = carManager.getReset();

    carManager.getUpdateReset()?.(frameDelta);
    input.updateControls(vehicle, reset, frameDelta);
    jump.update(frameDelta, !!vehicle && !input.isTyping() && input.keys.has('KeyJ'), vehicle);

    // Remote poses use the fixed network origin; remap them into this
    // player's view origin (differs only after a personal teleport), and
    // remap our own pose back before publishing.
    const { lat: viewOriginLat, lon: viewOriginLon } = addressSearch.getCurrentOrigin();
    function toViewFrame(pose) {
      const { x, z } = remapLocalOrigin(pose.x, pose.z, ORIGIN_LAT, ORIGIN_LON, viewOriginLat, viewOriginLon);
      return { ...pose, x, z };
    }

    const remotePoses = isJoined() ? net.remotePoses(now).map(toViewFrame) : [];

    // Remote cars are kinematic obstacles; place them before the step.
    if (isJoined()) remoteCollisions.sync(remotePoses);

    // Fixed-size steps (accumulator) + interpolated rendering: a varying
    // substep count per frame would show as jitter.
    accumulator += frameDelta;
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
      accumulator -= FIXED_STEP;
      substeps++;
    }
    // Lagging badly: drop the remainder instead of spiralling.
    if (accumulator > FIXED_STEP) accumulator = accumulator % FIXED_STEP;

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
    if (isJoined() && currentChassisMesh && currentVehicle) {
      if (!input.isTyping()) {
        const shot = shots.tryFire(currentVehicle.chassisBody, input.keys.has('KeyF'));
        if (shot) net.publishProps({ type: 'shot', ...shot });
      }
      scoring.update(frameDelta, currentChassisMesh, currentVehicle);
      pedestrians.updatePopulation(
        currentChassisMesh.position.x,
        currentChassisMesh.position.y,
        currentChassisMesh.position.z
      );
      poseForward.set(0, 0, 1).applyQuaternion(currentChassisMesh.quaternion);
      const velocity = currentVehicle.chassisBody.velocity;
      const { x: netX, z: netZ } = remapLocalOrigin(
        currentChassisMesh.position.x,
        currentChassisMesh.position.z,
        viewOriginLat,
        viewOriginLon,
        ORIGIN_LAT,
        ORIGIN_LON
      );
      net.publishPose({
        x: netX,
        y: currentChassisMesh.position.y,
        z: netZ,
        qx: currentChassisMesh.quaternion.x,
        qy: currentChassisMesh.quaternion.y,
        qz: currentChassisMesh.quaternion.z,
        qw: currentChassisMesh.quaternion.w,
        speed: velocity.x * poseForward.x + velocity.y * poseForward.y + velocity.z * poseForward.z,
        steer: currentVehicle.wheelInfos[0].steering,
        score: carManager.getScore(),
        horn: hornLevel,
      });
      if (now >= nextBallSend) {
        nextBallSend = now + 100;
        for (const pose of balls.ownedPoses()) net.publishProps({ type: 'ball', ...pose });
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
        odoKm: gaugesHud.getOdometerKm(),
      };
      if (now >= nextCarStateSave) {
        nextCarStateSave = now + CAR_STATE_SAVE_INTERVAL_MS;
        saveCarState(pendingCarState);
      }
    }

    cameraFollow(frameDelta, {
      chassisMesh: currentChassisMesh,
      podMesh: carManager.getPodMesh(),
      vehicle: currentVehicle,
      vehicleId: carManager.getVehicleId(),
    });
    gaugesHud.updateGauges(currentChassisMesh, currentVehicle);
    const debugVisualsEnabled = debugVisuals.isEnabled();
    terrainStatsHud.updateTerrainStats(frameDelta, {
      terrain,
      buildings,
      streets,
      rivers,
      waterAreas,
      chassisMesh: currentChassisMesh,
      debugVisualsEnabled,
      pedestrians,
      viewOriginLat,
      viewOriginLon,
    });
    // Wheel surface for the next physics steps' tyre grip (one frame lag).
    if (currentVehicle) {
      for (const wheel of currentVehicle.wheelInfos) {
        const pos = wheel.worldTransform.position;
        wheel.surface = classifySurfaceAt(pos.x, pos.z, { streets, waterAreas });
      }
    }
    suspensionHud.updateSuspensionHud(currentVehicle, debugVisualsEnabled, scoring.isLanded(), world, {
      streets,
      waterAreas,
    });
    // Effects run regardless of debug state. Splash also takes streets
    // (bridges don't splash) and rivers (narrow waterways).
    splash.update(frameDelta, currentVehicle, world, waterAreas, streets, rivers);
    tireSmoke.update(frameDelta, currentVehicle, world);
    terrainDust.update(frameDelta, currentVehicle, world);
    // Body dust is spawned by collide events; this only ages puffs.
    bodyDust.update(frameDelta);
    if (currentChassisMesh) {
      clouds.update(frameDelta, currentChassisMesh.position.x, currentChassisMesh.position.z, currentChassisMesh.position.y);
    }
    playersPanel.updatePlayersPanel(frameDelta, { net, carManager, isJoined });

    if (currentChassisMesh) {
      // Keep the sun and its shadow frustum centred on the car.
      sun.position.copy(SUN_OFFSET).add(currentChassisMesh.position);
      sun.target.position.copy(currentChassisMesh.position);
      sun.target.updateMatrixWorld();
      sunDisc.position.copy(SUN_OFFSET).multiplyScalar(5000).add(currentChassisMesh.position);

      // Stream around the car, but not during a teleport: the origin has
      // already moved while the car hasn't, so tile math would be bogus.
      if (!addressSearch.isTeleporting()) {
        // Facing prioritizes LOW-ring terrain tiles ahead of the car.
        terrainHeading.set(0, 0, 1).applyQuaternion(currentChassisMesh.quaternion);
        terrain.update(currentChassisMesh.position.x, currentChassisMesh.position.z, false, {
          x: terrainHeading.x,
          z: terrainHeading.z,
        });

        // Same DETAIL_ZOOM tile centre as TerrainManager computes.
        const { lat: carLat, lon: carLon } = localToLatLon(
          currentChassisMesh.position.x,
          currentChassisMesh.position.z,
          viewOriginLat,
          viewOriginLon
        );
        const tileX = Math.floor(lon2tileX(carLon, DETAIL_ZOOM));
        const tileY = Math.floor(lat2tileY(carLat, DETAIL_ZOOM));
        // Order: terrain (above), overlays, then buildings (most expensive).
        // Overlays always stream: they drive tyre grip and splash.
        // Every manager time-slices its building work.
        streets.update(tileX, tileY);
        rivers.update(tileX, tileY);
        waterAreas.update(tileX, tileY);
        buildings.update(tileX, tileY);
      }
      // Lift a car found inside a building onto its roof.
      preventBuildingEmbedding(currentVehicle);

      minimapHud.update(currentChassisMesh, { lat: viewOriginLat, lon: viewOriginLon }, remotePoses);
    }

    renderer.render(scene, camera);
  }

  return { animate };
}
