import { createCar, createRemoteCar } from '../lib/car.js';
import { BUILDING_COLLISION_GROUP } from '../lib/buildings.js';
import { GROUND_COLLISION_GROUP } from '../lib/terrain.js';
import { DEFAULT_VEHICLE_ID } from '../lib/vehicles/index.js';
import { DEFAULT_BODY_COLOR } from '../config.js';
import { applyImpactRoll } from './collisions.js';

// Local car lifecycle (spawn/respawn/swap) and the remote players' cars.

export function createCarManager({ world, scene, pedestrians, debugVisuals, bodyDust, playerSpawnPos, startQuat, playerSpawnQuat }) {
  let vehicle = null;
  let chassisMesh = null;
  // Chariot pod mesh (null for wheeled cars), for the pod camera view.
  let podMesh = null;
  let wheelMeshes = [];
  let syncMeshes = null;
  let snapshotPhysics = null;
  let reset = null;
  let updateReset = null;
  let setCarHitboxVisible = null;
  let stabilityAssistCallback = null;
  // Rig-specific cleanup for extra bodies/meshes (chariot); optional.
  let dispose = null;
  let localName = '';
  let score = 0;
  let currentColor = DEFAULT_BODY_COLOR;
  let currentVehicleId = DEFAULT_VEHICLE_ID;
  const remotes = new Map();

  function hookCar(nextVehicle, mesh) {
    nextVehicle.chassisBody.addEventListener('collide', (event) => {
      if (event.body.collisionFilterGroup === BUILDING_COLLISION_GROUP) {
        applyImpactRoll(nextVehicle.chassisBody, event.contact);
        return;
      }
      // Ground contact: body dust scaled by impact speed.
      if (event.body.collisionFilterGroup === GROUND_COLLISION_GROUP && bodyDust) {
        const contact = event.contact;
        const chassis = nextVehicle.chassisBody;
        // From the chassis centre, so it reads as the body, not the wheels.
        bodyDust.onGroundContact(chassis.position, Math.abs(contact.getImpactVelocityAlongNormal()), chassis.velocity);
      }
    });
    pedestrians.bindChassis(nextVehicle.chassisBody, nextVehicle.wheelHitboxBodies ?? []);
    // No name tag on our own car (others render their own copy).
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
    podMesh = null;
  }

  function spawnLocalCar(color, vehicleId) {
    currentColor = color;
    currentVehicleId = vehicleId ?? DEFAULT_VEHICLE_ID;
    removeCurrentCar();
    ({ vehicle, chassisMesh, podMesh, wheelMeshes, syncMeshes, snapshotPhysics, reset, updateReset, setHitboxVisible: setCarHitboxVisible, stabilityAssistCallback, dispose } = createCar(
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

  /** Swaps the vehicle kind in place (same pose and velocity); debug picker. */
  function setVehicleKind(vehicleId) {
    currentVehicleId = vehicleId ?? DEFAULT_VEHICLE_ID;
    if (!vehicle) return;
    const position = vehicle.chassisBody.position.clone();
    const quaternion = vehicle.chassisBody.quaternion.clone();
    const velocity = vehicle.chassisBody.velocity.clone();
    removeCurrentCar();
    ({ vehicle, chassisMesh, podMesh, wheelMeshes, syncMeshes, snapshotPhysics, reset, updateReset, setHitboxVisible: setCarHitboxVisible, stabilityAssistCallback, dispose } = createCar(
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

  /** Swaps the body colour in place; debug picker. */
  function setColor(color) {
    currentColor = color;
    if (!vehicle) return;
    const position = vehicle.chassisBody.position.clone();
    const quaternion = vehicle.chassisBody.quaternion.clone();
    const velocity = vehicle.chassisBody.velocity.clone();
    removeCurrentCar();
    ({ vehicle, chassisMesh, podMesh, wheelMeshes, syncMeshes, snapshotPhysics, reset, updateReset, setHitboxVisible: setCarHitboxVisible, stabilityAssistCallback, dispose } = createCar(
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
    ({ vehicle, chassisMesh, podMesh, wheelMeshes, syncMeshes, snapshotPhysics, reset, updateReset, setHitboxVisible: setCarHitboxVisible, stabilityAssistCallback, dispose } = createCar(
      world,
      scene,
      startPos,
      startQuat
    ));
    debugVisuals.setCarHitboxSetter(setCarHitboxVisible);
    hookCar(vehicle, chassisMesh);
  }

  // `poses` are already remapped into the view frame by mainLoop.
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
  }

  function setLocalName(name) {
    localName = name;
  }

  return {
    remotes,
    spawnLocalCar,
    spawnPreviewCar,
    setVehicleKind,
    setColor,
    updateRemotes,
    addScore,
    setLocalName,
    getScore: () => score,
    getLocalName: () => localName,
    getVehicleId: () => currentVehicleId,
    getColor: () => currentColor,
    // Getters: values change on (re)spawn, so read them every frame.
    getVehicle: () => vehicle,
    getChassisMesh: () => chassisMesh,
    getPodMesh: () => podMesh,
    getSyncMeshes: () => syncMeshes,
    getSnapshotPhysics: () => snapshotPhysics,
    getReset: () => reset,
    getUpdateReset: () => updateReset,
  };
}
