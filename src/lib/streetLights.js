// Street lamp lighting at night (streetLamps.js). Every lamp gets a glowing
// bulb and a fake additive light pool on the ground; a fixed pool of real
// spotlights follows the lamps nearest the car, the nearest one casting
// shadows. Lights stay in the scene permanently so the light count (and so
// every shader) never changes; by day they sit at zero.

import * as THREE from 'three';
import { LAMP_HEAD } from './streetLamps.js';

const ON_ELEVATION_DEG = 3; // sun below this: lamps on (a little before headlights)
const FADE_S = 2;
const REAL_LIGHTS = 4; // slot 0 casts the shadow
const LIGHT_COLOR = 0xffd9a0;
const LIGHT_INTENSITY = 150;
const LIGHT_DISTANCE_M = 35;
const LIGHT_DECAY = 2;
const LIGHT_ANGLE_RAD = 1.1;
const LIGHT_PENUMBRA = 0.6;
const SHADOW_MAP_SIZE = 512;
const BULB_INTENSITY = 3;
const GLOW_RADIUS_M = 9;
const GLOW_LIFT_M = 0.05;
const GLOW_OPACITY = 0.35;
const INITIAL_CAPACITY = 64;

function createGlowTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,217,160,1)');
  g.addColorStop(0.5, 'rgba(255,217,160,0.35)');
  g.addColorStop(1, 'rgba(255,217,160,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * @param {object} deps
 * @param {THREE.Scene} deps.scene
 * @param {import('./terrain.js').TerrainManager} deps.terrain
 * @param {ReturnType<typeof import('./roadside.js').createRoadside>} deps.roadside
 * @param {ReturnType<typeof import('./streetLamps.js').createStreetLampKind>} deps.lampKind
 */
export function createStreetLights({ scene, terrain, roadside, lampKind }) {
  const lights = [];
  for (let i = 0; i < REAL_LIGHTS; i++) {
    const light = new THREE.SpotLight(LIGHT_COLOR, 0, LIGHT_DISTANCE_M, LIGHT_ANGLE_RAD, LIGHT_PENUMBRA, LIGHT_DECAY);
    if (i === 0) {
      light.castShadow = true;
      light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = LIGHT_DISTANCE_M;
      light.shadow.bias = -0.0005;
      light.shadow.normalBias = 0.02;
    }
    scene.add(light, light.target);
    lights.push(light);
  }

  const glowGeometry = new THREE.PlaneGeometry(GLOW_RADIUS_M * 2, GLOW_RADIUS_M * 2).rotateX(-Math.PI / 2);
  const glowMaterial = new THREE.MeshBasicMaterial({
    map: createGlowTexture(),
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    fog: false,
  });
  let glow = null;
  let heads = []; // [{ x, y, z, groundY }] world coords, from the last roadside version
  let version = -1;
  let level = 0;
  const matrix = new THREE.Matrix4();
  const color = new THREE.Color();

  function ensureCapacity(count) {
    if (glow && glow.instanceMatrix.count >= count) return;
    let capacity = glow ? glow.instanceMatrix.count : INITIAL_CAPACITY;
    while (capacity < count) capacity *= 2;
    if (glow) {
      scene.remove(glow);
      glow.dispose();
    }
    glow = new THREE.InstancedMesh(glowGeometry, glowMaterial, capacity);
    glow.frustumCulled = false; // instances span the whole draw distance around the car
    glow.count = 0;
    scene.add(glow);
  }

  function rebuildHeads(transforms) {
    heads = [];
    for (let i = 0; i < transforms.length; i += 4) {
      const [x, y, z, yaw] = transforms.slice(i, i + 4);
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      const hx = x + sin * LAMP_HEAD.z + cos * LAMP_HEAD.x;
      const hz = z + cos * LAMP_HEAD.z - sin * LAMP_HEAD.x;
      heads.push({ x: hx, y: y + LAMP_HEAD.y, z: hz, groundY: terrain.surfaceHeightAt(hx, hz) ?? y });
    }
    ensureCapacity(heads.length);
    glow.position.set(0, 0, 0);
    heads.forEach((h, i) => glow.setMatrixAt(i, matrix.makeTranslation(h.x, h.groundY + GLOW_LIFT_M, h.z)));
    glow.count = heads.length;
    glow.instanceMatrix.needsUpdate = true;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3 | null} carPosition
   * @param {number} sunElevationDeg
   */
  function update(dt, carPosition, sunElevationDeg) {
    const target = sunElevationDeg < ON_ELEVATION_DEG ? 1 : 0;
    level = THREE.MathUtils.clamp(level + (target ? dt : -dt) / FADE_S, 0, 1);
    lampKind.bulbMaterial.emissiveIntensity = BULB_INTENSITY * level;
    glowMaterial.opacity = GLOW_OPACITY * level;
    if (glow) glow.visible = level > 0;
    // Frozen by day, but only once the map exists: sampling a never-rendered one is a GL error.
    lights[0].shadow.autoUpdate = level > 0 || !lights[0].shadow.map;

    const standing = roadside.standingTransforms('streetLamps');
    if (standing.version !== version) {
      version = standing.version;
      rebuildHeads(standing.transforms);
    }
    // Generic origin shifts move the glow mesh; heads follow it until the next rebuild.
    const ox = glow?.position.x ?? 0;
    const oz = glow?.position.z ?? 0;

    // Nearest lamps get the real lights (and lose their fake pool, which would double up).
    const nearest = carPosition
      ? heads
          .map((h, i) => ({ i, d: (h.x + ox - carPosition.x) ** 2 + (h.z + oz - carPosition.z) ** 2 }))
          .sort((a, b) => a.d - b.d)
          .slice(0, REAL_LIGHTS)
          .map(({ i }) => i)
      : [];
    lights.forEach((light, slot) => {
      const h = heads[nearest[slot]];
      light.intensity = h ? LIGHT_INTENSITY * level : 0;
      if (!h) return;
      light.position.set(h.x + ox, h.y, h.z + oz);
      light.target.position.set(h.x + ox, h.groundY, h.z + oz);
      light.target.updateMatrixWorld();
    });
    if (!glow || level === 0) return;
    for (let i = 0; i < heads.length; i++) glow.setColorAt(i, color.setScalar(nearest.includes(i) ? 0 : 1));
    if (glow.instanceColor) glow.instanceColor.needsUpdate = true;
  }

  return { update };
}
