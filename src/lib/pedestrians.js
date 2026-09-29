// Yellow low-poly figures you can drive through for a point. The body is a
// trigger (collisionResponse off) so the car is not bounced, but cannon-es
// still emits collide. Whoever runs one over scores locally and tells the
// room to delete that same id; everyone else's nameplate just shows the
// score from the pose stream.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

const PED_COUNT = 10;
const PED_GROUP = 16;
const LOCAL_CHASSIS_GROUP = 1;

const YELLOW = new THREE.MeshStandardMaterial({ color: 0xf1c40f, roughness: 0.55 });
const INK = new THREE.MeshStandardMaterial({ color: 0x2a2114, roughness: 0.8 });

const HEAD_GEO = new THREE.SphereGeometry(0.28, 10, 8);
const BODY_GEO = new THREE.BoxGeometry(0.42, 0.42, 0.26);
const ARM_GEO = new THREE.BoxGeometry(0.14, 0.28, 0.14);
const LEG_GEO = new THREE.BoxGeometry(0.14, 0.3, 0.14);

export function createPedestrians(scene, world, groundGroup) {
  const peds = new Map();
  const pendingHits = [];
  let onHit = () => {};

  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const rayResult = new CANNON.RaycastResult();

  function groundY(x, z, fallback) {
    rayFrom.set(x, (fallback ?? 0) + 80, z);
    rayTo.set(x, (fallback ?? 0) - 80, z);
    rayResult.reset();
    world.raycastClosest(rayFrom, rayTo, { collisionFilterMask: groundGroup }, rayResult);
    return rayResult.hasHit ? rayResult.hitPointWorld.y : (fallback ?? 0);
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

  function flushHits() {
    if (!pendingHits.length) return;
    const hits = pendingHits.splice(0);
    for (const id of hits) {
      if (removePed(id)) onHit(id);
    }
  }

  function spawnLocal(chassisBody, clientId) {
    const forward = new CANNON.Vec3(0, 0, 1);
    const right = new CANNON.Vec3(1, 0, 0);
    chassisBody.quaternion.vmult(forward, forward);
    chassisBody.quaternion.vmult(right, right);
    const origin = chassisBody.position;
    const batch = [];
    for (let i = 0; i < PED_COUNT; i++) {
      const ahead = 8 + Math.random() * 10;
      const side = (Math.random() - 0.5) * 12;
      const x = origin.x + forward.x * ahead + right.x * side;
      const z = origin.z + forward.z * ahead + right.z * side;
      const y = groundY(x, z, origin.y);
      const id = `${clientId}:${crypto.randomUUID()}`;
      addPed(id, x, y, z);
      batch.push({ id, x, y, z });
    }
    return batch;
  }

  return {
    addPed,
    removePed,
    bindChassis,
    flushHits,
    spawnLocal,
    setOnHit(fn) {
      onHit = fn;
    },
  };
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
