import { createCar, createRemoteCar } from '../lib/car.js';
import { BUILDING_COLLISION_GROUP } from '../lib/buildings.js';
import { GROUND_COLLISION_GROUP } from '../lib/terrain.js';
import { DEFAULT_VEHICLE_ID, getVehicle } from '../lib/vehicles/index.js';
import { DEFAULT_BODY_COLOR } from '../config.js';
import { applyImpactRoll, endImpact } from './collisions.js';
import { getTyreSetup } from '../lib/garage.js';
import { sameTyreSetup } from '../lib/tyres/setup.js';
import { wheelSide } from '../lib/wheelContact.js';

// Local car lifecycle (spawn/respawn/swap) and the remote players' cars.

/** initialFuel / initialTyres / initialHeat / initialDamage: { vehicleId, ... } from the save; respawns of that vehicle keep them. */
export function createCarManager({ world, scene, pedestrians, debugVisuals, bodyDust, bodyScrapeSound, impactSound, tyrePopSound, rimSparks, playerSpawnPos, startQuat, playerSpawnQuat, initialFuel = null, initialTyres = null, initialHeat = null, initialDamage = null }) {
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
  let carriedTyres = initialTyres; // { vehicleId, setup, savedAt?, wheels: [{ tread, punctured, tempC, dirt, wetness }], spares? }
  let currentTyreSetup = null; // null: the mode's pick for the vehicle (lib/garage.js)
  let carriedHeat = initialHeat; // { vehicleId, savedAt?, ...engineHeat getState() }; savedAt (save only) cools the engine by the time away
  let carriedDamage = initialDamage; // { vehicleId, shocks: [health per wheel], lamps: lampDamage getState(), gearbox: health }
  let carVehicleId = null; // vehicle id the current car was built as

  function getFuelState() {
    return vehicle?.fuel ? { vehicleId: carVehicleId, litres: vehicle.fuel.litres } : null;
  }

  function getHeatState() {
    return vehicle?.heat ? { vehicleId: carVehicleId, savedAt: Date.now(), ...vehicle.heat.getState() } : null;
  }

  function getDamageState() {
    return vehicle?.lamps ? { vehicleId: carVehicleId, shocks: vehicle.getShockState(), lamps: vehicle.lamps.getState(), gearbox: vehicle.engine.gearbox.getState() } : null;
  }

  function getTyreState() {
    return vehicle?.getTyreState ? { vehicleId: carVehicleId, setup: vehicle.tyreSetup, savedAt: Date.now(), wheels: vehicle.getTyreState(), spares: vehicle.spareTyres } : null;
  }

  function hookCar(nextVehicle, mesh) {
    carVehicleId = currentVehicleId;
    if (nextVehicle.fuel && carriedFuel?.vehicleId === carVehicleId && Number.isFinite(carriedFuel.litres)) {
      nextVehicle.fuel.setLitres(carriedFuel.litres);
    }
    // Same tyres only: saves from before tyre setups carry no setup.
    if (nextVehicle.setTyreState && carriedTyres?.vehicleId === carVehicleId && (!carriedTyres.setup || sameTyreSetup(carriedTyres.setup, nextVehicle.tyreSetup))) {
      const parkedS = Number.isFinite(carriedTyres.savedAt) ? (Date.now() - carriedTyres.savedAt) / 1000 : 0;
      nextVehicle.setTyreState(carriedTyres.wheels, parkedS);
    }
    // Spares stay in the boot whatever is fitted.
    if (nextVehicle.setSpareTyres && carriedTyres?.vehicleId === carVehicleId && Number.isInteger(carriedTyres.spares)) {
      nextVehicle.setSpareTyres(carriedTyres.spares);
    }
    if (nextVehicle.heat && carriedHeat?.vehicleId === carVehicleId) {
      const parkedS = Number.isFinite(carriedHeat.savedAt) ? (Date.now() - carriedHeat.savedAt) / 1000 : 0;
      nextVehicle.heat.setState(carriedHeat, parkedS);
    }
    if (nextVehicle.lamps && carriedDamage?.vehicleId === carVehicleId) {
      nextVehicle.setShockState(carriedDamage.shocks);
      nextVehicle.lamps.setState(carriedDamage.lamps);
      nextVehicle.engine.gearbox.setState(carriedDamage.gearbox);
    }
    nextVehicle.onTyrePop = (i) => {
      tyrePopSound?.play(wheelSide(nextVehicle.wheelInfos[i]));
      rimSparks?.burst(nextVehicle.wheelInfos[i], nextVehicle.chassisBody.velocity);
    };
    const onCollide = (body) => (event) => {
      const hitGroup = event.body.collisionFilterGroup;
      if (body === nextVehicle.chassisBody && nextVehicle.heat && (hitGroup === BUILDING_COLLISION_GROUP || hitGroup === GROUND_COLLISION_GROUP)) {
        const hit = endImpact(body, event.contact);
        if (hit.end === 1) nextVehicle.heat.hitRadiator(hit.speed);
        nextVehicle.lamps?.hit(hit.end, hit.x, hit.speed);
        nextVehicle.engine.gearbox.hit(hit.speed);
      }
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
    if (vehicle.heat) carriedHeat = { vehicleId: carVehicleId, ...vehicle.heat.getState() };
    carriedDamage = getDamageState() ?? carriedDamage;
    world.removeEventListener('preStep', vehicle.preStepCallback);
    if (stabilityAssistCallback) world.removeEventListener('preStep', stabilityAssistCallback);
    dispose?.();
    world.removeBody(vehicle.chassisBody);
    scene.remove(chassisMesh);
    for (const mesh of wheelMeshes) scene.remove(mesh);
    vehicle = null;
    podMesh = null;
  }

  function buildCar(position, quaternion) {
    ({ vehicle, chassisMesh, podMesh, wheelMeshes, syncMeshes, snapshotPhysics, reset, updateReset, setHitboxVisible: setCarHitboxVisible, stabilityAssistCallback, dispose, shiftOrigin: shiftRigOrigin, isResetting } = createCar(
      world,
      scene,
      position,
      quaternion,
      currentColor,
      currentVehicleId,
      currentTyreSetup ?? getTyreSetup(currentVehicleId)
    ));
    debugVisuals.setCarHitboxSetter(setCarHitboxVisible);
    hookCar(vehicle, chassisMesh);
  }

  /** Rebuilds the car with the current kind/colour/tyres, same pose and velocity. */
  function rebuildInPlace() {
    const position = vehicle.chassisBody.position.clone();
    const quaternion = vehicle.chassisBody.quaternion.clone();
    const velocity = vehicle.chassisBody.velocity.clone();
    removeCurrentCar();
    buildCar(position, quaternion);
    for (const body of [vehicle.chassisBody, ...(vehicle.extraBodies ?? [])]) body.velocity.copy(velocity);
  }

  function spawnLocalCar(color, vehicleId) {
    currentColor = color;
    currentVehicleId = vehicleId ?? DEFAULT_VEHICLE_ID;
    currentTyreSetup = null;
    removeCurrentCar();
    buildCar(playerSpawnPos(), playerSpawnQuat ? playerSpawnQuat() : startQuat);
  }

  /** Swaps the vehicle kind (and optionally colour) in place, same pose and velocity; debug picker. */
  function setVehicleKind(vehicleId, color = currentColor) {
    currentVehicleId = vehicleId ?? DEFAULT_VEHICLE_ID;
    currentColor = color;
    currentTyreSetup = null;
    if (vehicle) rebuildInPlace();
  }

  /** Swaps the body colour in place; debug picker. */
  function setColor(color) {
    currentColor = color;
    if (vehicle) rebuildInPlace();
  }

  /** Fits a tyre setup (tyres/setup.js) in place; new tyres unless it's the one already fitted. */
  function setTyreSetup(setup) {
    currentTyreSetup = setup;
    if (!vehicle) return;
    if (sameTyreSetup(setup, vehicle.tyreSetup)) {
      vehicle.repairTyres?.();
      return;
    }
    rebuildInPlace(); // the old tyres' state doesn't match the new setup, so they start fresh
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
    setTyreSetup,
    updateRemotes,
    getRemoteLights,
    shiftOrigin,
    addScore,
    setLocalName,
    getScore: () => score,
    getLocalName: () => localName,
    getVehicleId: () => currentVehicleId,
    getFuelState,
    getHeatState,
    getDamageState,
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
