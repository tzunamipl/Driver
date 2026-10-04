import * as THREE from 'three';
import { lon2tileX, lat2tileY, localToLatLon, remapLocalOrigin } from '../lib/geo.js';
import { DETAIL_ZOOM } from '../lib/terrain.js';
import { FIXED_STEP, MAX_SUBSTEPS, ORIGIN_LAT, ORIGIN_LON } from '../config.js';
import { saveCarState } from '../lib/carState.js';
import { classifySurfaceAt } from '../lib/terrainSurface.js';

// How often to persist the local car's position/orientation/odometer (see
// lib/carState.js) - frequent enough that a crash/refresh rarely loses more
// than a second of driving, infrequent enough to keep localStorage writes
// off the per-frame hot path.
const CAR_STATE_SAVE_INTERVAL_MS = 1000;

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
  // Last-computed save payload, kept fresh every joined frame so the
  // pagehide flush below can persist it immediately even if the reload
  // happens between two throttled saves.
  let pendingCarState = null;
  window.addEventListener('pagehide', () => {
    if (pendingCarState) saveCarState(pendingCarState);
  });
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
    jump.update(frameDelta, !!vehicle && !input.isTyping() && input.keys.has('KeyJ'), vehicle);

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

      // Kept fresh every frame (for the pagehide flush) but only actually
      // written to localStorage on the throttled interval below.
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

    cameraFollow(frameDelta, { chassisMesh: currentChassisMesh, vehicle: currentVehicle });
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
    // Per-wheel tyre-grip surface (road/water/normal - see
    // lib/surfaceCompounds.js) read by wheeledVehicle.js's applyFriction()
    // on the *next* physics step(s) this frame's accumulator loop runs -
    // same one-frame-lag timing splash.js already accepts for its own
    // wheel-on-water check below, using each wheel's last-known world
    // position rather than blocking on a fresh raycast mid-step.
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
    // Wheel-splash particles: independent of debugVisualsEnabled (see
    // lib/splash.js/vectorPolygonLayer.js's doc comments) so this shows
    // during normal play, not just with the debug overlay open.
    splash.update(frameDelta, currentVehicle, world, waterAreas);
    // Tyre-smoke particles: reads wheel.sliding/wheel.surface (already set
    // above/by wheeledVehicle.js's friction solve), so like splash.js this
    // runs unconditionally - not gated on debugVisualsEnabled.
    tireSmoke.update(frameDelta, currentVehicle, world);
    playersPanel.updatePlayersPanel(frameDelta, { net, carManager, isJoined });

    if (currentChassisMesh) {
      // Keep the sun (and its shadow frustum) centered on the car so
      // shadows keep rendering as it drives away from the spawn point.
      sun.position.copy(SUN_OFFSET).add(currentChassisMesh.position);
      sun.target.position.copy(currentChassisMesh.position);
      sun.target.updateMatrixWorld();

      // Stream terrain/buildings chunks in/out as the car moves (cheap
      // no-op if the player is still inside the currently-loaded tile) -
      // but never while a teleport (ui/addressSearch.js's recenter()) is
      // in flight. During that window terrain.originLat/originLon have
      // already flipped to the destination while the chassis mesh is
      // still sitting at its *old* local position (it only moves once
      // recenter() resolves and reset() runs), so computing a tile center
      // from the two here would reinterpret stale local coordinates
      // against the new origin and stream in a bogus, unrelated
      // neighborhood - clobbering TerrainManager's center bookkeeping out
      // from under the recenter() call already streaming in the real
      // destination tiles (visible as tiles stuck "planned" in the debug
      // HUD while the loaded-tile count climbs from the stray fetches).
      if (!addressSearch.isTeleporting()) {
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
        const tileX = Math.floor(lon2tileX(carLon, DETAIL_ZOOM));
        const tileY = Math.floor(lat2tileY(carLat, DETAIL_ZOOM));
        // Load priority: terrain (above, needed for driving/physics) first,
        // then roads/rivers, then buildings last - buildings are by far
        // the most expensive to construct (per-building convex hull/
        // raycasts/extrusion, see buildings.js), so kicking off their
        // fetch/build last means the cheaper, more immediately important
        // content (ground to drive on, then the debug road/river overlay)
        // is never left waiting behind it. All four stream on the same
        // tile grid but only actually fetch/build anything once it's their
        // turn to matter: rivers only while the debug overlay is visible
        // (see vectorLineLayer.js's update() early-return) - but streets
        // and waterAreas always fetch/build regardless of that toggle,
        // since their data also drives per-wheel tyre-grip surface
        // classification/splash.js's wheel-on-water check respectively
        // (see vectorLineLayer.js's alwaysStream option doc comment and
        // vectorPolygonLayer.js's own doc comment) - and
        // every manager time-slices its own CPU-heavy mesh/physics
        // building across frames (see buildings.js's BUILD_TIME_BUDGET_MS)
        // rather than doing it all in the frame it becomes available, so
        // none of this ever freezes a frame.
        streets.update(tileX, tileY);
        rivers.update(tileX, tileY);
        waterAreas.update(tileX, tileY);
        buildings.update(tileX, tileY);
      }
      // Catch a car that ended up inside a building's solid volume - a
      // tile streaming in under an already-parked car, or a teleport
      // landing on a spot a building occupies - and lift it onto the
      // roof. Checked here (frame cadence) rather than per physics
      // substep since that's also how buildings stream in/teleports land.
      preventBuildingEmbedding(currentVehicle);

      minimapHud.update(currentChassisMesh, { lat: viewOriginLat, lon: viewOriginLon }, remotePoses);
    }

    renderer.render(scene, camera);
  }

  return { animate };
}
