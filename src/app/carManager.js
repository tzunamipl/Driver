import { createCar, createRemoteCar } from '../lib/car.js';
import { BUILDING_COLLISION_GROUP } from '../lib/buildings.js';
import { GROUND_COLLISION_GROUP } from '../lib/terrain.js';
import { DEFAULT_VEHICLE_ID, getVehicle } from '../lib/vehicles/index.js';
import { DEFAULT_BODY_COLOR } from '../config.js';
import { applyImpactRoll } from './collisions.js';

// Local car lifecycle (spawn/respawn/swap) and the remote players' cars.

/** initialFuel / initialTyres: { vehicleId, ... } from the save; respawns of that vehicle keep them. */
export function createCarManager({ world, scene, pedestrians, debugVisuals, bodyDust, bodyScrapeSound, impactSound, tyrePopSound, playerSpawnPos, startQuat, playerSpawnQuat, initialFuel = null, initialTyres = null }) {
  let vehicle = null;
  let chassisMesh = null;
  // Chariot pod mesh (null for wheeled cars), for the pod camera view.
  let podMesh = null;
  let wheelMeshes = [];
  let syncMeshes = null;
  let snapshotPhysics = null;
  let reset = null;
  let updateReset = null;
  let isResetting = null;
  let setCarHitboxVisible = null;
  let stabilityAssistCallback = null;
  // Rig-specific cleanup for extra bodies/meshes (chariot); optional.
  let dispose = null;
  let shiftRigOrigin = null;
  let localName = '';
  let score = 0;
  let currentColor = DEFAULT_BODY_COLOR;
  let currentVehicleId = DEFAULT_VEHICLE_ID;
  const remotes = new Map();
  // Fuel of the last car removed (or the save), so a recolour/respawn doesn't refill it.
  let carriedFuel = initialFuel;
  let carriedTyres = initialTyres; // { vehicleId, wheels: [{ tread, punctured }] }
  let carVehicleId = null; // vehicle id the current car was built as

  function getFuelState() {
    return vehicle?.fuel ? { vehicleId: carVehicleId, litres: vehicle.fuel.litres } : null;
  }

  function getTyreState() {
    return vehicle?.getTyreState ? { vehicleId: carVehicleId, wheels: vehicle.getTyreState() } : null;
  }

  function hookCar(nextVehicle, mesh) {
    carVehicleId = currentVehicleId;
    if (nextVehicle.fuel && carriedFuel?.vehicleId === carVehicleId && Number.isFinite(carriedFuel.litres)) {
      nextVehicle.fuel.setLitres(carriedFuel.litres);
    }
    if (nextVehicle.setTyreState && carriedTyres?.vehicleId === carVehicleId) nextVehicle.setTyreState(carriedTyres.wheels);
    nextVehicle.onTyrePop = () => tyrePopSound?.play();
    const onCollide = (body) => (event) => {
      if (event.body.collisionFilterGroup === BUILDING_COLLISION_GROUP) {
        applyImpactRoll(body, event.contact);
        impactSound?.play(Math.abs(event.contact.getImpactVelocityAlongNormal()));
        return;
      }
      if (event.body.collisionFilterGroup === GROUND_COLLISION_GROUP) bodyScrapeSound?.onGroundContact(body);
      // Ground contact: body dust scaled by impact speed.
      if (event.body.collisionFilterGroup === GROUND_COLLISION_GROUP && bodyDust) {
        const contact = event.contact;
        const chassis = body;
        // From the body centre, so it reads as the body, not the wheels.
        bodyDust.onGroundContact(chassis.position, Math.abs(contact.getImpactVelocityAlongNormal()), chassis.velocity);
      }
    };
    // Extra bodies (a trailer) get the same building/ground responses.
    for (const body of [nextVehicle.chassisBody, ...(nextVehicle.extraBodies ?? [])]) {
      body.addEventListener('collide', onCollide(body));
    }
    pedestrians.bindChassis(nextVehicle.chassisBody, [
      ...(nextVehicle.wheelHitboxBodies ?? []),
      ...(nextVehicle.extraBodies ?? []),
    ]);
    // No name tag on our own car (others render their own copy).
  }

  function removeCurrentCar() {
    if (!vehicle) return;
    carriedFuel = getFuelState() ?? carriedFuel;
    carriedTyres = getTyreState() ?? carriedTyres;
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
    ({ vehicle, chassisMesh, podMesh, wheelMeshes, syncMeshes, snapshotPhysics, reset, updateReset, setHitboxVisible: setCarHitboxVisible, stabilityAssistCallback, dispose, shiftOrigin: shiftRigOrigin, isResetting } = createCar(
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

  /** Swaps the vehicle kind (and optionally colour) in place, same pose and velocity; debug picker. */
  function setVehicleKind(vehicleId, color = currentColor) {
    currentVehicleId = vehicleId ?? DEFAULT_VEHICLE_ID;
    currentColor = color;
    if (!vehicle) return;
    const position = vehicle.chassisBody.position.clone();
    const quaternion = vehicle.chassisBody.quaternion.clone();
    const velocity = vehicle.chassisBody.velocity.clone();
    removeCurrentCar();
    ({ vehicle, chassisMesh, podMesh, wheelMeshes, syncMeshes, snapshotPhysics, reset, updateReset, setHitboxVisible: setCarHitboxVisible, stabilityAssistCallback, dispose, shiftOrigin: shiftRigOrigin, isResetting } = createCar(
      world,
      scene,
      position,
      quaternion,
      currentColor,
      currentVehicleId
    ));
    for (const body of [vehicle.chassisBody, ...(vehicle.extraBodies ?? [])]) body.velocity.copy(velocity);
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
    ({ vehicle, chassisMesh, podMesh, wheelMeshes, syncMeshes, snapshotPhysics, reset, updateReset, setHitboxVisible: setCarHitboxVisible, stabilityAssistCallback, dispose, shiftOrigin: shiftRigOrigin, isResetting } = createCar(
      world,
      scene,
      position,
      quaternion,
      currentColor,
      currentVehicleId
    ));
    for (const body of [vehicle.chassisBody, ...(vehicle.extraBodies ?? [])]) body.velocity.copy(velocity);
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
        remote.wheeled = getVehicle(pose.vehicleId).vehicleType !== 'hover';
        remotes.set(pose.id, remote);
      } else {
        remote.setAppearance(pose.color, pose.name, pose.score ?? 0);
      }
      remote.setPose(pose, dt);
      remote.lights = pose.lights;
    }
    for (const [id, remote] of remotes) {
      if (seen.has(id)) continue;
      remote.dispose();
      remotes.delete(id);
    }
  }

  /**
   * Floating-origin shift for local-car state outside the physics bodies and
   * scene objects (shifted generically by floatingOrigin.js).
   */
  function shiftOrigin(dx, dz) {
    shiftRigOrigin?.(dx, dz);
    for (const wheel of vehicle?.wheelInfos ?? []) {
      for (const p of [wheel.worldTransform?.position, wheel.connectionPointWorld, wheel.raycastResult?.hitPointWorld]) {
        if (!p) continue;
        p.x -= dx;
        p.z -= dz;
      }
    }
  }

  /** Remote cars for the headlights pass; `defaultOn` covers peers that don't send a light state. */
  function getRemoteLights(defaultOn) {
    const list = [];
    for (const remote of remotes.values()) list.push({ mesh: remote.mesh, wheeled: remote.wheeled, on: remote.lights ?? defaultOn });
    return list;
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
    setVehicleKind,
    setColor,
    updateRemotes,
    getRemoteLights,
    shiftOrigin,
    addScore,
    setLocalName,
    getScore: () => score,
    getLocalName: () => localName,
    getVehicleId: () => currentVehicleId,
    getFuelState,
    getTyreState,
    getColor: () => currentColor,
    // Getters: values change on (re)spawn, so read them every frame.
    getVehicle: () => vehicle,
    getChassisMesh: () => chassisMesh,
    getPodMesh: () => podMesh,
    getSyncMeshes: () => syncMeshes,
    getSnapshotPhysics: () => snapshotPhysics,
    getReset: () => reset,
    getUpdateReset: () => updateReset,
    // True while a reset/teleport eases the car into place.
    isResetting: () => !!isResetting?.(),
  };
}
