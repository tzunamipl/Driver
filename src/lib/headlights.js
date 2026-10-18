import * as THREE from 'three';

// Cosmetic headlights: glowing lenses and flare sprites on every car, plus
// one weak shadowless spotlight for the local car's ground pool. Lamp meshes are found by `material.userData.lamp`
// ('head' | 'tail' | 'fog'); bodies without head lamps get bumper-corner
// fallbacks. The spotlight lives in the scene permanently so the light
// count (and so every shader) never changes.

const FADE_S = 0.12;
const FLARE_SIZE_M = 0.0;
const POOL_INTENSITY = 340;
const POOL_DISTANCE_M = 300;
const POOL_ANGLE_RAD = 0.98;
const POOL_AIM = new THREE.Vector3(0, -1.6, 18); // target, relative to the lamps' midpoint
const MIN_SIDE_X_M = 0.1; // centre lamps (light bars) glow but get no flare
const LAMP_ON = {
  head: { color: new THREE.Color(0xfff4dc), intensity: 1.6 },
  fog: { color: new THREE.Color(0xffe6a0), intensity: 1.3 },
  tail: { color: new THREE.Color(0xff1a10), intensity: 1.4 },
};

let flareTexture = null;
function getFlareTexture() {
  if (flareTexture) return flareTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,244,220,0.8)');
  g.addColorStop(1, 'rgba(255,230,190,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  flareTexture = new THREE.CanvasTexture(canvas);
  flareTexture.colorSpace = THREE.SRGBColorSpace;
  return flareTexture;
}

/** Group-local bounding box of `mesh`. */
function localBox(mesh, groupInverse, target) {
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  return target.copy(mesh.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(groupInverse, mesh.matrixWorld));
}

/** Head lamp positions (group-local) and every lamp material under `group`. */
function scanLamps(group, fallback) {
  group.updateMatrixWorld(true);
  const inverse = group.matrixWorld.clone().invert();
  const materials = new Map(); // material -> kind
  const sides = { left: new THREE.Box3(), right: new THREE.Box3() };
  const all = new THREE.Box3();
  const box = new THREE.Box3();
  const center = new THREE.Vector3();
  group.traverse((obj) => {
    if (!obj.isMesh) return;
    let head = false;
    for (const material of [obj.material].flat()) {
      const kind = material?.userData?.lamp;
      if (!LAMP_ON[kind]) continue;
      materials.set(material, kind);
      if (kind === 'head') head = true;
    }
    localBox(obj, inverse, box);
    all.union(box);
    if (!head) return;
    box.getCenter(center);
    // Front half only: some rigs reuse the lens material on rear markers.
    if (center.z <= 0 || Math.abs(center.x) < MIN_SIDE_X_M) return;
    sides[center.x > 0 ? 'left' : 'right'].union(box);
  });
  const lamps = [];
  for (const side of [sides.left, sides.right]) {
    if (side.isEmpty()) continue;
    side.getCenter(center);
    lamps.push(new THREE.Vector3(center.x, center.y, side.max.z));
  }
  if (!lamps.length && fallback && !all.isEmpty()) {
    const halfWidth = (all.max.x - all.min.x) / 2;
    const y = all.min.y + (all.max.y - all.min.y) * 0.35;
    for (const sx of [1, -1]) lamps.push(new THREE.Vector3(all.getCenter(center).x + sx * halfWidth * 0.7, y, all.max.z));
  }
  return { lamps, materials };
}

/** Attaches headlight visuals to a car body group; `setLevel(0..1)` fades them. */
function createRig(group, fallback) {
  const { lamps, materials } = scanLamps(group, fallback);
  const lenses = [...materials].map(([material, kind]) => ({
    material,
    on: LAMP_ON[kind],
    emissive: material.emissive?.clone(),
    intensity: material.emissiveIntensity ?? 1,
  }));
  const flareMat = new THREE.SpriteMaterial({
    map: getFlareTexture(),
    color: 0xfff4dc,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const parts = [];
  for (const lamp of lamps) {
    const flare = new THREE.Sprite(flareMat);
    flare.position.copy(lamp).add(new THREE.Vector3(0, 0, 0.06));
    flare.scale.setScalar(FLARE_SIZE_M);
    flare.renderOrder = 2;
    flare.visible = false;
    group.add(flare);
    parts.push(flare);
  }
  const midpoint = new THREE.Vector3();
  for (const lamp of lamps) midpoint.addScaledVector(lamp, 1 / lamps.length);

  let level = 0;
  function apply() {
    for (const part of parts) part.visible = level > 0;
    flareMat.opacity = level;
    for (const lens of lenses) {
      if (lens.emissive) lens.material.emissive.lerpColors(lens.emissive, lens.on.color, level);
      lens.material.emissiveIntensity = THREE.MathUtils.lerp(lens.intensity, lens.on.intensity, level);
    }
  }

  /** Eases toward on/off; returns the current level. */
  function update(dt, on) {
    const target = on ? 1 : 0;
    if (level === target) return level;
    level = THREE.MathUtils.clamp(level + (on ? dt : -dt) / FADE_S, 0, 1);
    apply();
    return level;
  }

  return { update, group, midpoint, hasLamps: lamps.length > 0 };
}

export function createHeadlights(scene) {
  const rigs = new WeakMap(); // body group -> rig
  const pool = new THREE.SpotLight(0xfff1d6, 0, POOL_DISTANCE_M, POOL_ANGLE_RAD, 0.75, 2);
  pool.castShadow = false;
  scene.add(pool, pool.target);
  const worldPos = new THREE.Vector3();

  function rigFor(group, fallback) {
    let rig = rigs.get(group);
    if (!rig) {
      // Inside the visible body's group when it has one (car.js sinks it in water).
      rig = createRig(group.userData.contentGroup ?? group, fallback);
      rigs.set(group, rig);
    }
    return rig;
  }

  /**
   * @param {number} dt
   * @param {{ chassisMesh?: THREE.Object3D, wheeled: boolean, on: boolean,
   *   remotes: Iterable<{ mesh: THREE.Object3D, wheeled: boolean, on: boolean }> }} state
   */
  function update(dt, { chassisMesh, wheeled, on, remotes }) {
    let poolLevel = 0;
    if (chassisMesh && wheeled) {
      const rig = rigFor(chassisMesh, true);
      const level = rig.update(dt, on);
      if (rig.hasLamps) {
        poolLevel = level;
        rig.group.localToWorld(worldPos.copy(rig.midpoint));
        pool.position.copy(worldPos);
        rig.group.localToWorld(worldPos.copy(rig.midpoint).add(POOL_AIM));
        pool.target.position.copy(worldPos);
        pool.target.updateMatrixWorld();
      }
    }
    pool.intensity = POOL_INTENSITY * poolLevel;
    for (const remote of remotes) {
      if (remote.mesh && remote.wheeled) rigFor(remote.mesh, true).update(dt, remote.on);
    }
  }

  return { update };
}
