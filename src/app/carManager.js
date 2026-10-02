import { createCar, createRemoteCar, createNameTag } from '../lib/car.js';
import { BUILDING_COLLISION_GROUP } from '../lib/buildings.js';
import { DEFAULT_VEHICLE_ID } from '../lib/vehicles/index.js';
import { DEFAULT_BODY_COLOR } from '../config.js';
import { applyImpactRoll } from './collisions.js';

// Owns the local car's lifecycle (spawn/respawn/despawn) plus the roster of
// remote players' cars. Bridges physics (car body), rendering (meshes/name
// tags), gameplay (pedestrian binding, score), and networking (remote pose
// sync) - kept as one module since spawning/despawning a car inherently
// touches all of those, but exposes a narrow API so callers (main loop,
// lobby, address search) don't need to know the wiring details.

export function createCarManager({ world, scene, pedestrians, debugVisuals, playerSpawnPos, startQuat, playerSpawnQuat }) {
  let vehicle = null;
  let chassisMesh = null;
  let wheelMeshes = [];
  let syncMeshes = null;
  let snapshotPhysics = null;
  let reset = null;
  let updateReset = null;
  let setCarHitboxVisible = null;
  let stabilityAssistCallback = null;
  // Only set for vehicle kinds that own extra bodies/meshes beyond the one
  // chassisBody/chassisMesh pair this module cleans up generically below
  // (currently just the hover rig's separately-tethered pod - see
  // lib/chariot.js). undefined for wheeled cars, so `dispose?.()` safely
  // no-ops for those.
  let dispose = null;
  let localName = '';
  let score = 0;
  let nameTag = null;
  let currentColor = DEFAULT_BODY_COLOR;
  let currentVehicleId = DEFAULT_VEHICLE_ID;
  const remotes = new Map();

  function hookCar(nextVehicle, mesh) {
    nextVehicle.chassisBody.addEventListener('collide', (event) => {
      if (event.body.collisionFilterGroup !== BUILDING_COLLISION_GROUP) return;
      applyImpactRoll(nextVehicle.chassisBody, event.contact);
    });
    pedestrians.bindChassis(nextVehicle.chassisBody, nextVehicle.wheelHitboxBodies ?? []);
    if (nameTag?.sprite.parent) nameTag.sprite.parent.remove(nameTag.sprite);
    nameTag = createNameTag(localName, score);
    mesh.add(nameTag.sprite);
  }

  function removeCurrentCar() {
    if (!vehicle) return;
    world.removeEventListener('preStep', vehicle.preStepCallback);
    if (stabilityAssistCallback) world.removeEventListener('preStep', stabilityAssistCallback);
    dispose?.();
    world.removeBody(vehicle.chassisBody);
    scene.remove(chassisMesh);
    for (const mesh of wheelMeshes) scene.remove(mesh);
    vehicle = null;
  }

  function spawnLocalCar(color, vehicleId) {
    currentColor = color;
    currentVehicleId = vehicleId ?? DEFAULT_VEHICLE_ID;
    removeCurrentCar();
    ({ vehicle, chassisMesh, wheelMeshes, syncMeshes, snapshotPhysics, reset, updateReset, setHitboxVisible: setCarHitboxVisible, stabilityAssistCallback, dispose } = createCar(
      world,
      scene,
      playerSpawnPos(),
      playerSpawnQuat ? playerSpawnQuat() : startQuat,
      currentColor,
      currentVehicleId
    ));
    debugVisuals.setCarHitboxSetter(setCarHitboxVisible);
    hookCar(vehicle, chassisMesh);
  }

  /**
   * Instantly swaps the local car's vehicle kind in place - same position,
   * heading and velocity, just a different body/mesh underneath - used by
   * the debug view's vehicle picker (see hud/vehicleDebugPicker.js) so
   * trying out a vehicle mid-drive doesn't also reset where you are. A
   * no-op before a car exists (nothing to swap yet; the next spawn just
   * picks it up via currentVehicleId).
   */
  function setVehicleKind(vehicleId) {
    currentVehicleId = vehicleId ?? DEFAULT_VEHICLE_ID;
    if (!vehicle) return;
    const position = vehicle.chassisBody.position.clone();
    const quaternion = vehicle.chassisBody.quaternion.clone();
    const velocity = vehicle.chassisBody.velocity.clone();
    removeCurrentCar();
    ({ vehicle, chassisMesh, wheelMeshes, syncMeshes, snapshotPhysics, reset, updateReset, setHitboxVisible: setCarHitboxVisible, stabilityAssistCallback, dispose } = createCar(
      world,
      scene,
      position,
      quaternion,
      currentColor,
      currentVehicleId
    ));
    vehicle.chassisBody.velocity.copy(velocity);
    debugVisuals.setCarHitboxSetter(setCarHitboxVisible);
    hookCar(vehicle, chassisMesh);
  }

  /** Spawns the shared "preview" car used before a player has joined a room. */
  function spawnPreviewCar(startPos) {
    removeCurrentCar();
    ({ vehicle, chassisMesh, wheelMeshes, syncMeshes, snapshotPhysics, reset, updateReset, setHitboxVisible: setCarHitboxVisible, stabilityAssistCallback, dispose } = createCar(
      world,
      scene,
      startPos,
      startQuat
    ));
    debugVisuals.setCarHitboxSetter(setCarHitboxVisible);
    hookCar(vehicle, chassisMesh);
  }

  // `poses` is already fetched (and remapped into this player's own local
  // view frame - see app/mainLoop.js's toViewFrame) by the caller once per
  // frame, so this doesn't hit the network layer itself.
  function updateRemotes(dt, poses) {
    const seen = new Set();
    for (const pose of poses) {
      seen.add(pose.id);
      let remote = remotes.get(pose.id);
      if (!remote) {
        remote = createRemoteCar(scene, pose.color, pose.name, pose.score ?? 0, pose.vehicleId);
        remotes.set(pose.id, remote);
      } else {
        remote.setAppearance(pose.color, pose.name, pose.score ?? 0);
      }
      remote.setPose(pose, dt);
    }
    for (const [id, remote] of remotes) {
      if (seen.has(id)) continue;
      remote.dispose();
      remotes.delete(id);
    }
  }

  function addScore(delta) {
    score += delta;
    nameTag?.set(localName, score);
  }

  function setLocalName(name) {
    localName = name;
  }

  return {
    remotes,
    spawnLocalCar,
    spawnPreviewCar,
    setVehicleKind,
    updateRemotes,
    addScore,
    setLocalName,
    getScore: () => score,
    getLocalName: () => localName,
    getVehicleId: () => currentVehicleId,
    // Live accessors - the underlying values are reassigned on
    // (re)spawn, so callers must read these via the getter each frame
    // rather than destructuring once.
    getVehicle: () => vehicle,
    getChassisMesh: () => chassisMesh,
    getSyncMeshes: () => syncMeshes,
    getSnapshotPhysics: () => snapshotPhysics,
    getReset: () => reset,
    getUpdateReset: () => updateReset,
  };
}
