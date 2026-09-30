// Yellow low-poly figures you can drive through for a point. The body is a
// trigger (collisionResponse off) so the car is not bounced, but cannon-es
// still emits collide. Whoever runs one over scores locally and tells the
// room to delete that same id; everyone else's nameplate just shows the
// score from the pose stream.
//
// Figures are scattered on a fixed grid around the driver, not placed by a
// button. The cell hash is the same for every client, so a friend driving
// the same streets meets the same figures. A hit id is remembered and is
// not placed again.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

const PED_GROUP = 16;
const LOCAL_CHASSIS_GROUP = 1;
// One candidate every 90 m. One cell in four actually grows a figure, so a
// few hundred metres of loaded streets hold about a dozen of them.
const CELL_M = 90;
const SPAWN_RADIUS_M = 320;
const DESPAWN_RADIUS_M = 480;
const SCAN_INTERVAL_MS = 500;

const YELLOW = new THREE.MeshStandardMaterial({ color: 0xf1c40f, roughness: 0.55 });
const INK = new THREE.MeshStandardMaterial({ color: 0x2a2114, roughness: 0.8 });

const HEAD_GEO = new THREE.SphereGeometry(0.28, 10, 8);
const BODY_GEO = new THREE.BoxGeometry(0.42, 0.42, 0.26);
const ARM_GEO = new THREE.BoxGeometry(0.14, 0.28, 0.14);
const LEG_GEO = new THREE.BoxGeometry(0.14, 0.3, 0.14);

export function createPedestrians(scene, world, groundGroup) {
  const peds = new Map();
  const killed = new Set();
  const pendingHits = [];
  let onHit = () => {};
  let nextScan = 0;

  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const rayResult = new CANNON.RaycastResult();

  function groundY(x, z, aroundY) {
    const y = aroundY ?? 0;
    rayFrom.set(x, y + 200, z);
    rayTo.set(x, y - 200, z);
    rayResult.reset();
    world.raycastClosest(rayFrom, rayTo, { collisionFilterMask: groundGroup }, rayResult);
    return rayResult.hasHit ? rayResult.hitPointWorld.y : null;
  }

  function addPed(id, x, y, z) {
    if (!id || peds.has(id)) return;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const mesh = buildPed();
    mesh.position.set(x, y, z);
    mesh.rotation.y = Math.random() * Math.PI * 2;
    scene.add(mesh);

    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.STATIC,
      collisionResponse: false,
      collisionFilterGroup: PED_GROUP,
      collisionFilterMask: LOCAL_CHASSIS_GROUP,
    });
    body.addShape(new CANNON.Sphere(0.45), new CANNON.Vec3(0, 0.7, 0));
    body.position.set(x, y, z);
    body.pedId = id;
    world.addBody(body);
    peds.set(id, { mesh, body });
  }

  function removePed(id) {
    const ped = peds.get(id);
    if (!ped) return false;
    world.removeBody(ped.body);
    scene.remove(ped.mesh);
    ped.mesh.traverse((obj) => {
      if (obj.geometry && !SHARED_GEOS.has(obj.geometry)) obj.geometry.dispose();
    });
    peds.delete(id);
    return true;
  }

  function bindChassis(chassisBody) {
    chassisBody.addEventListener('collide', (event) => {
      const id = event.body?.pedId;
      if (!id || !peds.has(id) || pendingHits.includes(id)) return;
      pendingHits.push(id);
    });
  }

  function forget(id) {
    if (!id) return false;
    killed.add(id);
    return removePed(id);
  }

  function flushHits() {
    if (!pendingHits.length) return;
    const hits = pendingHits.splice(0);
    for (const id of hits) {
      if (forget(id)) onHit(id);
    }
  }

  // Fill the streets around the car. Far figures are dropped locally so the
  // world doesn't grow without bound; driving back recreates any that were
  // not run over.
  function updatePopulation(x, y, z) {
    const now = performance.now();
    if (now < nextScan) return;
    nextScan = now + SCAN_INTERVAL_MS;

    const spawnR2 = SPAWN_RADIUS_M * SPAWN_RADIUS_M;
    const minIx = Math.floor((x - SPAWN_RADIUS_M) / CELL_M);
    const maxIx = Math.floor((x + SPAWN_RADIUS_M) / CELL_M);
    const minIz = Math.floor((z - SPAWN_RADIUS_M) / CELL_M);
    const maxIz = Math.floor((z + SPAWN_RADIUS_M) / CELL_M);
    for (let ix = minIx; ix <= maxIx; ix++) {
      for (let iz = minIz; iz <= maxIz; iz++) {
        const id = `ped:${ix}:${iz}`;
        if (killed.has(id) || peds.has(id) || !cellHasPed(ix, iz)) continue;
        const point = pointInCell(ix, iz);
        const dx = point.x - x;
        const dz = point.z - z;
        if (dx * dx + dz * dz > spawnR2) continue;
        const ground = groundY(point.x, point.z, y);
        if (ground == null) continue;
        addPed(id, point.x, ground, point.z);
      }
    }

    const despawnR2 = DESPAWN_RADIUS_M * DESPAWN_RADIUS_M;
    for (const [id, ped] of peds) {
      const dx = ped.body.position.x - x;
      const dz = ped.body.position.z - z;
      if (dx * dx + dz * dz > despawnR2) removePed(id);
    }
  }

  return {
    addPed,
    removePed,
    forget,
    bindChassis,
    flushHits,
    updatePopulation,
    setOnHit(fn) {
      onHit = fn;
    },
  };
}

function cellHash(ix, iz) {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return h >>> 0;
}

function cellHasPed(ix, iz) {
  return cellHash(ix, iz) % 4 === 0;
}

function pointInCell(ix, iz) {
  const h = cellHash(ix, iz);
  const fx = 0.2 + ((h % 1000) / 1000) * 0.6;
  const fz = 0.2 + (((h >>> 10) % 1000) / 1000) * 0.6;
  return { x: (ix + fx) * CELL_M, z: (iz + fz) * CELL_M };
}

const SHARED_GEOS = new Set([HEAD_GEO, BODY_GEO, ARM_GEO, LEG_GEO]);

function buildPed() {
  const group = new THREE.Group();
  const add = (geo, material, x, y, z) => {
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    group.add(mesh);
  };
  add(LEG_GEO, INK, -0.1, 0.22, 0);
  add(LEG_GEO, INK, 0.1, 0.22, 0);
  add(BODY_GEO, YELLOW, 0, 0.68, 0);
  add(ARM_GEO, YELLOW, -0.3, 0.72, 0);
  add(ARM_GEO, YELLOW, 0.3, 0.72, 0);
  add(HEAD_GEO, YELLOW, 0, 1.18, 0);
  return group;
}
