import * as THREE from 'three';

// Cosmetic headlights: glowing lenses and flare sprites on every car, plus
// two weak shadowless spotlights for the local car's ground pools: front, and rear
// (red tail, brighter on the brake, white in reverse). Lamp meshes are found by `material.userData.lamp`
// ('head' | 'tail' | 'fog'); bodies without head lamps get bumper-corner
// fallbacks. The spotlights live in the scene permanently so the light
// count (and so every shader) never changes.

const FADE_S = 0.12;
const FLARE_SIZE_M = 0.6;
const POOL_INTENSITY = 320; // ~same brightness at the aim point as 4000 with decay 2
const POOL_DISTANCE_M = 200;
const POOL_DECAY = 1.0; // gentler than physical inverse-square so the beam reaches further
const POOL_ANGLE_RAD = 0.9;
const POOL_AIM = new THREE.Vector3(0, -1.6, 18); // target, relative to the lamps' midpoint
const REAR_DISTANCE_M = 30;
const REAR_DECAY = 1.0;
const REAR_ANGLE_RAD = 1.0;
const REAR_AIM = new THREE.Vector3(0, -1.2, -6); // target, relative to the tail lamps' midpoint
const REAR_TAIL_INTENSITY = 1;
const REAR_BRAKE_INTENSITY = 7;
const REAR_REVERSE_INTENSITY = 8;
const REAR_RED = new THREE.Color(0xff1a10);
const REAR_WHITE = new THREE.Color(0xfff4e6);
const BRAKE_LENS_BOOST = 1.6; // added to tail lens emissive intensity at full brake
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
  const tails = new THREE.Box3();
  const all = new THREE.Box3();
  const box = new THREE.Box3();
  const center = new THREE.Vector3();
  group.traverse((obj) => {
    if (!obj.isMesh) return;
    let head = false;
    let tail = false;
    for (const material of [obj.material].flat()) {
      const kind = material?.userData?.lamp;
      if (!LAMP_ON[kind]) continue;
      materials.set(material, kind);
      if (kind === 'head') head = true;
      if (kind === 'tail') tail = true;
    }
    localBox(obj, inverse, box);
    all.union(box);
    box.getCenter(center);
    if (tail && center.z < 0) tails.union(box);
    if (!head) return;
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
  let rear = null;
  if (!tails.isEmpty()) rear = new THREE.Vector3(tails.getCenter(center).x, center.y, tails.min.z);
  else if (!all.isEmpty()) rear = new THREE.Vector3(all.getCenter(center).x, all.min.y + (all.max.y - all.min.y) * 0.35, all.min.z);
  return { lamps, materials, rear };
}

function ease(value, on, dt) {
  return THREE.MathUtils.clamp(value + (on ? dt : -dt) / FADE_S, 0, 1);
}

/** Attaches headlight visuals to a car body group; `setLevel(0..1)` fades them. */
function createRig(group, fallback) {
  const { lamps, materials, rear } = scanLamps(group, fallback);
  const lenses = [...materials].map(([material, kind]) => ({
    material,
    tail: kind === 'tail',
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
  let brake = 0;
  function apply() {
    for (const part of parts) part.visible = level > 0;
    flareMat.opacity = level;
    for (const lens of lenses) {
      const k = lens.tail ? Math.max(level, brake) : level;
      if (lens.emissive) lens.material.emissive.lerpColors(lens.emissive, lens.on.color, k);
      lens.material.emissiveIntensity = THREE.MathUtils.lerp(lens.intensity, lens.on.intensity, k) + (lens.tail ? brake * BRAKE_LENS_BOOST : 0);
    }
  }

  /** Eases lights and brake lamps toward on/off; returns { level, brake }. */
  function update(dt, on, braking = false) {
    const nextLevel = ease(level, on, dt);
    const nextBrake = ease(brake, braking, dt);
    if (nextLevel !== level || nextBrake !== brake) {
      level = nextLevel;
      brake = nextBrake;
      apply();
    }
    return { level, brake };
  }

  return { update, group, midpoint, rear, hasLamps: lamps.length > 0 };
}

export function createHeadlights(scene) {
  const rigs = new WeakMap(); // body group -> rig
  const pool = new THREE.SpotLight(0xfff1d6, 0, POOL_DISTANCE_M, POOL_ANGLE_RAD, 0.75, POOL_DECAY);
  pool.castShadow = false;
  scene.add(pool, pool.target);
  const rearPool = new THREE.SpotLight(REAR_RED, 0, REAR_DISTANCE_M, REAR_ANGLE_RAD, 0.8, REAR_DECAY);
  rearPool.castShadow = false;
  scene.add(rearPool, rearPool.target);
  const worldPos = new THREE.Vector3();
  let reverse = 0;

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
   * @param {{ chassisMesh?: THREE.Object3D, wheeled: boolean, on: boolean, braking?: boolean, reversing?: boolean,
   *   remotes: Iterable<{ mesh: THREE.Object3D, wheeled: boolean, on: boolean }> }} state
   */
  function update(dt, { chassisMesh, wheeled, on, braking = false, reversing = false, remotes }) {
    let poolLevel = 0;
    let rearIntensity = 0;
    if (chassisMesh && wheeled) {
      const rig = rigFor(chassisMesh, true);
      const { level, brake } = rig.update(dt, on, braking);
      reverse = ease(reverse, reversing, dt);
      if (rig.rear) {
        const red = Math.max(REAR_TAIL_INTENSITY * level, REAR_BRAKE_INTENSITY * brake);
        rearIntensity = THREE.MathUtils.lerp(red, REAR_REVERSE_INTENSITY, reverse);
        rearPool.color.lerpColors(REAR_RED, REAR_WHITE, reverse);
        rig.group.localToWorld(worldPos.copy(rig.rear));
        rearPool.position.copy(worldPos);
        rig.group.localToWorld(worldPos.copy(rig.rear).add(REAR_AIM));
        rearPool.target.position.copy(worldPos);
        rearPool.target.updateMatrixWorld();
      }
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
    rearPool.intensity = rearIntensity;
    for (const remote of remotes) {
      if (remote.mesh && remote.wheeled) rigFor(remote.mesh, true).update(dt, remote.on);
    }
  }

  return { update };
}
