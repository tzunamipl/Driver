import * as THREE from 'three';
import { GLINT_UNIFORMS, clearGlint, glintCone, setGlint } from './lampGlints.js';

// Cosmetic headlights: glowing lenses and flare sprites on every car, plus
// two weak shadowless spotlights for the local car's ground pools: front, and rear
// (red tail, brighter on the brake, white in reverse). Lamp meshes are found by `material.userData.lamp`
// ('head' | 'tail' | 'fog'); bodies without head lamps get bumper-corner
// fallbacks. Broken lamps (lampDamage.js) stay dark and take their share of
// the ground pool. The spotlights live in the scene permanently so the light
// count (and so every shader) never changes. On the road surface (streets.js) the pools only
// light; their glint comes from lampGlints.js instead, one per lamp.

const FADE_S = 0.12;
const FLARE_SIZE_M = 0.6;
const POOL_INTENSITY = 120; // ~same brightness at the aim point as 4000 with decay 2
const POOL_DISTANCE_M = 200;
const POOL_DECAY = 1.0; // gentler than physical inverse-square so the beam reaches further
const POOL_ANGLE_RAD = 0.9;
const POOL_PENUMBRA = 0.75;
const POOL_AIM = new THREE.Vector3(0, -1.6, 18); // target, relative to the lamps' midpoint
const REAR_DISTANCE_M = 30;
const REAR_DECAY = 1.0;
const REAR_ANGLE_RAD = 1.0;
const REAR_PENUMBRA = 0.8;
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

const POOL_CONE = glintCone(POOL_ANGLE_RAD, POOL_PENUMBRA, POOL_DECAY);
const REAR_CONE = glintCone(REAR_ANGLE_RAD, REAR_PENUMBRA, REAR_DECAY);

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

/** Lamp slot from a mesh's group-local centre: end ('head' front / 'tail' rear) and side (0 = +x, 1 = -x, -1 = centre). */
function slotOf(center) {
  return { end: center.z > 0 ? 'head' : 'tail', side: Math.abs(center.x) < MIN_SIDE_X_M ? -1 : center.x > 0 ? 0 : 1 };
}

/**
 * Head lamp positions (group-local) and every lamp material under `group`, each with its slot.
 * A lens material shared by several slots is cloned per slot so one side can break alone.
 */
function scanLamps(group, fallback) {
  group.updateMatrixWorld(true);
  const inverse = group.matrixWorld.clone().invert();
  const materials = new Map(); // material -> { kind, end, side }
  const clones = new Map(); // `${slot}` -> Map(original -> clone)
  const present = { head: [false, false], tail: [false, false] };
  const sides = [new THREE.Box3(), new THREE.Box3()];
  const tails = new THREE.Box3();
  const tailSides = [new THREE.Box3(), new THREE.Box3()];
  const all = new THREE.Box3();
  const box = new THREE.Box3();
  const center = new THREE.Vector3();
  group.traverse((obj) => {
    if (!obj.isMesh) return;
    localBox(obj, inverse, box);
    all.union(box);
    box.getCenter(center);
    const slot = slotOf(center);
    const slotKey = `${slot.end}:${slot.side}`;
    let head = false;
    let tail = false;
    const list = [obj.material].flat();
    list.forEach((material, j) => {
      const kind = material?.userData?.lamp;
      if (!LAMP_ON[kind]) return;
      let lens = material;
      const owner = materials.get(material);
      if (owner && (owner.end !== slot.end || owner.side !== slot.side)) {
        if (!clones.has(slotKey)) clones.set(slotKey, new Map());
        const perSlot = clones.get(slotKey);
        if (!perSlot.has(material)) perSlot.set(material, material.clone());
        lens = perSlot.get(material);
        if (Array.isArray(obj.material)) {
          obj.material = obj.material.slice();
          obj.material[j] = lens;
        } else obj.material = lens;
      }
      if (!materials.has(lens)) materials.set(lens, { kind, ...slot });
      if (slot.side >= 0) present[slot.end][slot.side] = true;
      if (kind === 'head') head = true;
      if (kind === 'tail') tail = true;
    });
    if (tail && center.z < 0) {
      tails.union(box);
      if (slot.side >= 0) tailSides[slot.side].union(box);
    }
    if (!head) return;
    // Front half only: some rigs reuse the lens material on rear markers.
    if (center.z <= 0 || slot.side < 0) return;
    sides[slot.side].union(box);
  });
  const lamps = []; // { position, side }
  sides.forEach((sideBox, side) => {
    if (sideBox.isEmpty()) return;
    sideBox.getCenter(center);
    lamps.push({ position: new THREE.Vector3(center.x, center.y, sideBox.max.z), side });
  });
  if (!lamps.length && fallback && !all.isEmpty()) {
    const halfWidth = (all.max.x - all.min.x) / 2;
    const y = all.min.y + (all.max.y - all.min.y) * 0.35;
    [1, -1].forEach((sx, side) => {
      lamps.push({ position: new THREE.Vector3(all.getCenter(center).x + sx * halfWidth * 0.7, y, all.max.z), side });
      present.head[side] = true;
    });
  }
  let rear = null;
  if (!tails.isEmpty()) rear = new THREE.Vector3(tails.getCenter(center).x, center.y, tails.min.z);
  else if (!all.isEmpty()) rear = new THREE.Vector3(all.getCenter(center).x, all.min.y + (all.max.y - all.min.y) * 0.35, all.min.z);
  const rearLamps = []; // { position, side }
  tailSides.forEach((sideBox, side) => {
    if (sideBox.isEmpty()) return;
    sideBox.getCenter(center);
    rearLamps.push({ position: new THREE.Vector3(center.x, center.y, sideBox.min.z), side });
  });
  if (!rearLamps.length && rear) rearLamps.push({ position: rear, side: -1 });
  return { lamps, materials, rear, rearLamps, present };
}

function ease(value, on, dt) {
  return THREE.MathUtils.clamp(value + (on ? dt : -dt) / FADE_S, 0, 1);
}

const NO_DAMAGE = { head: [false, false], tail: [false, false] };

/** Share of an end's lamps still working (lampDamage.js `broken`); sides it has no lamp on don't count. */
function workingShare(present, broken) {
  const fitted = present.some(Boolean) ? [0, 1].filter((i) => present[i]) : [0, 1];
  return fitted.filter((i) => !broken[i]).length / fitted.length;
}

/** Attaches headlight visuals to a car body group; `update` fades them, broken lamps stay dark. */
function createRig(group, fallback) {
  const { lamps, materials, rear, rearLamps, present } = scanLamps(group, fallback);
  const lenses = [...materials].map(([material, { kind, end, side }]) => ({
    material,
    tail: kind === 'tail',
    end,
    side,
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
    flare.position.copy(lamp.position).add(new THREE.Vector3(0, 0, 0.06));
    flare.scale.setScalar(FLARE_SIZE_M);
    flare.renderOrder = 2;
    flare.visible = false;
    group.add(flare);
    parts.push({ flare, side: lamp.side });
  }
  const midpoint = new THREE.Vector3();
  for (const lamp of lamps) midpoint.addScaledVector(lamp.position, 1 / lamps.length);

  let level = 0;
  let brake = 0;
  let broken = NO_DAMAGE;
  let brokenKey = 0;
  // A centre lamp (light bar) goes dark only with both sides of its end.
  const isBroken = (end, side) => (side < 0 ? broken[end][0] && broken[end][1] : broken[end][side]);
  function apply() {
    for (const part of parts) part.flare.visible = level > 0 && !broken.head[part.side];
    flareMat.opacity = level;
    for (const lens of lenses) {
      const k = isBroken(lens.end, lens.side) ? 0 : lens.tail ? Math.max(level, brake) : level;
      if (lens.emissive) lens.material.emissive.lerpColors(lens.emissive, lens.on.color, k);
      lens.material.emissiveIntensity = THREE.MathUtils.lerp(lens.intensity, lens.on.intensity, k) + (lens.tail && k > 0 ? brake * BRAKE_LENS_BOOST : 0);
    }
  }

  /** Eases lights and brake lamps toward on/off; returns { level, brake }. */
  function update(dt, on, braking = false, damage = NO_DAMAGE) {
    const nextLevel = ease(level, on, dt);
    const nextBrake = ease(brake, braking, dt);
    const nextKey = damage.head[0] + 2 * damage.head[1] + 4 * damage.tail[0] + 8 * damage.tail[1];
    if (nextLevel !== level || nextBrake !== brake || nextKey !== brokenKey) {
      level = nextLevel;
      brake = nextBrake;
      broken = damage;
      brokenKey = nextKey;
      apply();
    }
    return { level, brake };
  }

  return {
    update,
    group,
    midpoint,
    rear,
    lamps,
    rearLamps,
    isBroken: (end, side) => isBroken(end, side),
    hasLamps: lamps.length > 0,
    headShare: () => workingShare(present.head, broken.head),
    tailShare: () => workingShare(present.tail, broken.tail),
  };
}

export function createHeadlights(scene) {
  const rigs = new WeakMap(); // body group -> rig
  const pool = new THREE.SpotLight(0xfff1d6, 0, POOL_DISTANCE_M, POOL_ANGLE_RAD, POOL_PENUMBRA, POOL_DECAY);
  pool.castShadow = false;
  scene.add(pool, pool.target);
  const rearPool = new THREE.SpotLight(REAR_RED, 0, REAR_DISTANCE_M, REAR_ANGLE_RAD, REAR_PENUMBRA, REAR_DECAY);
  rearPool.castShadow = false;
  scene.add(rearPool, rearPool.target);
  const worldPos = new THREE.Vector3();
  const aim = new THREE.Vector3();
  let reverse = 0;

  /** Glint slots `first`, `first` + 1: the rig's lamps of one end, splitting `intensity` between them. */
  function setGlints(first, rig, end, list, aimLocal, cone, distance, intensity, color) {
    rig.group.updateMatrixWorld();
    aim.copy(aimLocal).transformDirection(rig.group.matrixWorld);
    for (let k = 0; k < 2; k++) {
      const lamp = list[k];
      if (!lamp || rig.isBroken(end, lamp.side)) continue;
      rig.group.localToWorld(worldPos.copy(lamp.position));
      setGlint(first + k, worldPos, aim, cone, distance, intensity / list.length, color);
    }
  }

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
   *   damage?: { head: boolean[], tail: boolean[] },
   *   remotes: Iterable<{ mesh: THREE.Object3D, wheeled: boolean, on: boolean }> }} state
   */
  function update(dt, { chassisMesh, wheeled, on, braking = false, reversing = false, damage, remotes }) {
    let poolLevel = 0;
    let rearIntensity = 0;
    for (let i = 0; i < 4; i++) clearGlint(i);
    if (chassisMesh && wheeled) {
      const rig = rigFor(chassisMesh, true);
      const { level, brake } = rig.update(dt, on, braking, damage);
      reverse = ease(reverse, reversing, dt);
      if (rig.rear) {
        const red = Math.max(REAR_TAIL_INTENSITY * level, REAR_BRAKE_INTENSITY * brake);
        const rearAll = THREE.MathUtils.lerp(red, REAR_REVERSE_INTENSITY, reverse);
        rearIntensity = rearAll * rig.tailShare();
        rearPool.color.lerpColors(REAR_RED, REAR_WHITE, reverse);
        if (rearAll > 0) setGlints(2, rig, 'tail', rig.rearLamps, REAR_AIM, REAR_CONE, REAR_DISTANCE_M, rearAll, rearPool.color);
        rig.group.localToWorld(worldPos.copy(rig.rear));
        rearPool.position.copy(worldPos);
        rig.group.localToWorld(worldPos.copy(rig.rear).add(REAR_AIM));
        rearPool.target.position.copy(worldPos);
        rearPool.target.updateMatrixWorld();
      }
      if (rig.hasLamps) {
        poolLevel = level * rig.headShare();
        if (level > 0) setGlints(0, rig, 'head', rig.lamps, POOL_AIM, POOL_CONE, POOL_DISTANCE_M, POOL_INTENSITY * level, pool.color);
        rig.group.localToWorld(worldPos.copy(rig.midpoint));
        pool.position.copy(worldPos);
        rig.group.localToWorld(worldPos.copy(rig.midpoint).add(POOL_AIM));
        pool.target.position.copy(worldPos);
        pool.target.updateMatrixWorld();
      }
    }
    pool.intensity = POOL_INTENSITY * poolLevel;
    rearPool.intensity = rearIntensity;
    GLINT_UNIFORMS.carPoolPos.value[0].copy(pool.position);
    GLINT_UNIFORMS.carPoolPos.value[1].copy(rearPool.position);
    for (const remote of remotes) {
      if (remote.mesh && remote.wheeled) rigFor(remote.mesh, true).update(dt, remote.on);
    }
  }

  return { update };
}
