// Street lamp lighting at night (streetLamps.js). Every lamp gets a glowing
// bulb; a fixed pool of real spotlights follows the lamps nearest the car,
// the nearest one casting shadows; the next ones only glint on the wet road (lampGlints.js). Lights stay in the scene permanently so the light count (and so
// every shader) never changes; by day they sit at zero.

import * as THREE from 'three';
import { LAMP_HEAD } from './streetLamps.js';
import { addGlintSource, glintCone } from './lampGlints.js';

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
const GLINT_AIM = { x: 0, y: -1, z: 0 };
const GLINT_CONE = glintCone(LIGHT_ANGLE_RAD, LIGHT_PENUMBRA, LIGHT_DECAY);
const GLINT_COLOR = new THREE.Color(LIGHT_COLOR);

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

  let heads = []; // [{ x, y, z, groundY }] world coords, from the last roadside version
  let version = -1;
  let level = 0;
  let real = new Set(); // heads indices with a real spotlight

  addGlintSource((add, x, z, rangeSq) => {
    if (level <= 0) return;
    heads.forEach((h, i) => {
      if (!real.has(i) && (h.x - x) ** 2 + (h.z - z) ** 2 <= rangeSq) add(h, GLINT_AIM, GLINT_CONE, LIGHT_DISTANCE_M, LIGHT_INTENSITY * level, GLINT_COLOR);
    });
  });

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
    // Frozen by day, but only once the map exists: sampling a never-rendered one is a GL error.
    lights[0].shadow.autoUpdate = level > 0 || !lights[0].shadow.map;

    const standing = roadside.standingTransforms('streetLamps');
    if (standing.version !== version) {
      version = standing.version;
      rebuildHeads(standing.transforms);
    }
    const nearest = carPosition
      ? heads
          .map((h, i) => ({ i, d: (h.x - carPosition.x) ** 2 + (h.z - carPosition.z) ** 2 }))
          .sort((a, b) => a.d - b.d)
          .slice(0, REAL_LIGHTS)
          .map(({ i }) => i)
      : [];
    real = new Set(nearest);
    lights.forEach((light, slot) => {
      const h = heads[nearest[slot]];
      light.intensity = h ? LIGHT_INTENSITY * level : 0;
      if (!h) return;
      light.position.set(h.x, h.y, h.z);
      light.target.position.set(h.x, h.groundY, h.z);
      light.target.updateMatrixWorld();
    });
  }

  function shiftOrigin(dx, dz) {
    for (const h of heads) {
      h.x -= dx;
      h.z -= dz;
    }
  }

  return { update, shiftOrigin };
}
