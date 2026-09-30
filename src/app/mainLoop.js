import * as THREE from 'three';
import { lon2tileX, lat2tileY, localToLatLon, remapLocalOrigin } from '../lib/geo.js';
import { DETAIL_ZOOM } from '../lib/terrain.js';
import { FIXED_STEP, MAX_SUBSTEPS, ORIGIN_LAT, ORIGIN_LON } from '../config.js';

// The main animate() loop: fixed-timestep physics stepping (with the
// ground-tunneling guard and interpolated render transforms), then
// per-frame gameplay/HUD/camera/streaming updates and networking pose
// publishing. This is the composition point that ties every other module
// together each frame - it deliberately contains no physics/camera/HUD
// *logic* of its own, only the call order between them.

export function createMainLoop({
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
  shots,
  horn,
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
  scoring,
  isJoined,
}) {
  let lastTime = performance.now();
  let accumulator = 0;
  let nextBallSend = 0;
  const poseForward = new THREE.Vector3();

  function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const frameDelta = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    const vehicle = carManager.getVehicle();
    const chassisMesh = carManager.getChassisMesh();
    const reset = carManager.getReset();

    carManager.getUpdateReset()?.(frameDelta);
    input.updateControls(vehicle, reset);

    // This player's own local (0, 0) origin - equal to the fixed network
    // origin normally, but can diverge after a personal teleport (see
    // ui/addressSearch.js). Every remote pose (always encoded relative to
    // the fixed network origin - see config.js's ORIGIN_LAT/ORIGIN_LON)
    // needs remapping into *this* frame before it means anything as a
    // scene position here, and this player's own pose needs the inverse
    // remap before publishing, so everyone else keeps interpreting it
    // relative to the one frame they all still share.
    const { lat: viewOriginLat, lon: viewOriginLon } = addressSearch.getCurrentOrigin();
    function toViewFrame(pose) {
      const { x, z } = remapLocalOrigin(pose.x, pose.z, ORIGIN_LAT, ORIGIN_LON, viewOriginLat, viewOriginLon);
      return { ...pose, x, z };
    }

    // Computed once per frame (rather than re-fetched/re-mapped at each of
    // the three call sites below) since net.remotePoses() itself does
    // interpolation work, and the remap is a no-op fast path when this
    // player hasn't teleported anyway.
    const remotePoses = isJoined() ? net.remotePoses(now).map(toViewFrame) : [];

    // Remote cars are kinematic obstacles. Place them before the step so
    // the local chassis actually contacts them this frame (see
    // remoteCollisions.js).
    if (isJoined()) remoteCollisions.sync(remotePoses);

    // Advance physics in fixed-size steps (accumulator pattern) instead of
    // a single variable-size world.step() call. requestAnimationFrame
    // deltas rarely divide evenly into FIXED_STEP, so letting cannon-es
    // pick its own substep count each frame makes that count flicker
    // (e.g. 1, 1, 2, 1...), which reads as jitter/stutter at high speed
    // even though the underlying motion is smooth. Stepping fixed-size
    // chunks ourselves and interpolating the render transform (see
    // snapshotPhysics/syncMeshes) removes that.
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
    // If we're badly lagging (hit MAX_SUBSTEPS), drop the remainder instead
    // of letting it snowball into a "spiral of death" of ever-growing
    // catch-up.
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
      // Remap this player's own local (view-frame) position back into the
      // fixed network origin's frame before publishing - see the
      // toViewFrame() comment above for why (a no-op unless this player
      // has personally teleported).
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
    }

    cameraFollow(frameDelta, { chassisMesh: currentChassisMesh, vehicle: currentVehicle });
    gaugesHud.updateGauges(currentChassisMesh, currentVehicle);
    const debugVisualsEnabled = debugVisuals.isEnabled();
    terrainStatsHud.updateTerrainStats(frameDelta, { terrain, buildings, chassisMesh: currentChassisMesh, debugVisualsEnabled, pedestrians });
    suspensionHud.updateSuspensionHud(currentVehicle, debugVisualsEnabled, scoring.isLanded(), world);
    playersPanel.updatePlayersPanel(frameDelta, { net, carManager, isJoined });

    if (currentChassisMesh) {
      // Keep the sun (and its shadow frustum) centered on the car so
      // shadows keep rendering as it drives away from the spawn point.
      sun.position.copy(SUN_OFFSET).add(currentChassisMesh.position);
      sun.target.position.copy(currentChassisMesh.position);
      sun.target.updateMatrixWorld();

      // Stream terrain chunks in/out as the car moves (cheap no-op if the
      // player is still inside the currently-loaded tile).
      terrain.update(currentChassisMesh.position.x, currentChassisMesh.position.z);

      // Buildings stream on the same DETAIL_ZOOM tile grid as the terrain
      // detail tier; compute the current tile center the same way
      // TerrainManager.update() does internally so the two stay aligned.
      const { lat: carLat, lon: carLon } = localToLatLon(
        currentChassisMesh.position.x,
        currentChassisMesh.position.z,
        viewOriginLat,
        viewOriginLon
      );
      buildings.update(
        Math.floor(lon2tileX(carLon, DETAIL_ZOOM)),
        Math.floor(lat2tileY(carLat, DETAIL_ZOOM))
      );

      minimapHud.update(currentChassisMesh, { lat: viewOriginLat, lon: viewOriginLon }, remotePoses);
    }

    renderer.render(scene, camera);
  }

  return { animate };
}
