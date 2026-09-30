import * as THREE from 'three';
import { lon2tileX, lat2tileY, localToLatLon } from '../lib/geo.js';
import { DETAIL_ZOOM } from '../lib/terrain.js';
import { FIXED_STEP, MAX_SUBSTEPS } from '../config.js';

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

    // Remote cars are kinematic obstacles. Place them before the step so
    // the local chassis actually contacts them this frame (see
    // remoteCollisions.js).
    if (isJoined()) remoteCollisions.sync(net.remotePoses(now));

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
      world.step(FIXED_STEP);
      preventGroundTunneling(carManager.getVehicle());
      const snapshotPhysics = carManager.getSnapshotPhysics();
      if (snapshotPhysics) snapshotPhysics();
      pedestrians.flushHits();
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

    const currentChassisMesh = carManager.getChassisMesh();
    const currentVehicle = carManager.getVehicle();
    if (isJoined() && currentChassisMesh && currentVehicle) {
      scoring.update(frameDelta, currentChassisMesh, currentVehicle);
      pedestrians.updatePopulation(
        currentChassisMesh.position.x,
        currentChassisMesh.position.y,
        currentChassisMesh.position.z
      );
      poseForward.set(0, 0, 1).applyQuaternion(currentChassisMesh.quaternion);
      const velocity = currentVehicle.chassisBody.velocity;
      net.publishPose({
        x: currentChassisMesh.position.x,
        y: currentChassisMesh.position.y,
        z: currentChassisMesh.position.z,
        qx: currentChassisMesh.quaternion.x,
        qy: currentChassisMesh.quaternion.y,
        qz: currentChassisMesh.quaternion.z,
        qw: currentChassisMesh.quaternion.w,
        speed: velocity.x * poseForward.x + velocity.y * poseForward.y + velocity.z * poseForward.z,
        steer: currentVehicle.wheelInfos[0].steering,
        score: carManager.getScore(),
      });
      if (now >= nextBallSend) {
        nextBallSend = now + 100;
        for (const pose of balls.ownedPoses()) net.publishProps({ type: 'ball', ...pose });
      }
      carManager.updateRemotes(frameDelta);
    }

    cameraFollow(frameDelta, { chassisMesh: currentChassisMesh, vehicle: currentVehicle });
    gaugesHud.updateGauges(currentChassisMesh, currentVehicle);
    const debugVisualsEnabled = debugVisuals.isEnabled();
    terrainStatsHud.updateTerrainStats(frameDelta, { terrain, buildings, chassisMesh: currentChassisMesh, debugVisualsEnabled });
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
      const { lat: originLat, lon: originLon } = addressSearch.getCurrentOrigin();
      const { lat: carLat, lon: carLon } = localToLatLon(
        currentChassisMesh.position.x,
        currentChassisMesh.position.z,
        originLat,
        originLon
      );
      buildings.update(
        Math.floor(lon2tileX(carLon, DETAIL_ZOOM)),
        Math.floor(lat2tileY(carLat, DETAIL_ZOOM))
      );
    }

    renderer.render(scene, camera);
  }

  return { animate };
}
