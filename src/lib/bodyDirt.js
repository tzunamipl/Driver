// Body dirt of the own car: one level, 0 clean .. 1 caked. Dirty tyres
// (tyres/condition.js wheel.dirt) fling it onto the body as they turn, any
// driving adds slow road grime, wading rinses it off; reset with the car
// (hard reset, new car). Drawn in the body paint shader: a dust film that dulls
// the clearcoat, plus mud splatter creeping up from the sills (higher at the rear, in
// the wheels' wake), over the paint scratches of bodyScratches.js.

import * as THREE from 'three';
import {
  PART_OFFSET_M,
  SCRATCH_FRAGMENT_HEAD,
  SCRATCH_COLOR_FRAGMENT,
  SCRATCH_ROUGHNESS_FRAGMENT,
  SCRATCH_METALNESS_FRAGMENT,
  SCRATCH_CLEARCOAT_FRAGMENT,
} from './bodyScratches.js';

const FLING_PER_M = 1 / 1500; // share of the clean paint caked per metre of tyre turned at wheel.dirt 1
const GRIME_PER_M = 1 / 250_000; // share per metre driven on any surface
const WASH_MIN_DEPTH_M = 0.15; // shallower water doesn't reach the body
const WASH_DEPTH_M = 0.6; // full rinse from this deep
const WASH_PER_S = 0.25; // share rinsed off per second at full depth, standing
const WASH_SPEED_MS = 5; // driving through rinses (1 + speed / this) x faster
const DUST_COLOR = new THREE.Color(0x9a8a70);
const MUD_COLOR = new THREE.Color(0x4b3a28);

/**
 * @param {THREE.Object3D[]} groups - body groups (chassis, trailer) whose paint gets dirty.
 * @param {object} scratchUniforms - bodyScratches.js `uniforms`, drawn under the dirt.
 * @returns {{ level: number, enabled: boolean, update(dt: number, vehicle: object, enabled: boolean): void, wash(): void,
 *   getState(): number, setState(level: unknown): void }}
 */
export function createBodyDirt(groups, scratchUniforms) {
  const uniform = { value: 0 };
  groups.forEach((group, part) => patchPaint(group, part, uniform, scratchUniforms));

  const dirt = {
    level: 0,
    /** Settings > Graphics car dirt; off draws the rims clean too. */
    enabled: true,
    /** Per frame; `enabled` off: no build-up and a clean look (the level is kept). */
    update(dt, vehicle, enabled) {
      if (enabled && !vehicle.noDamage) step(dt, vehicle);
      dirt.enabled = enabled;
      uniform.value = enabled ? dirt.level : 0;
    },
    wash() {
      dirt.level = 0;
    },
    getState: () => dirt.level,
    setState(level) {
      if (Number.isFinite(level)) dirt.level = THREE.MathUtils.clamp(level, 0, 1);
    },
  };

  function step(dt, vehicle) {
    const speed = vehicle.chassisBody.velocity.length();
    const depth = vehicle.waterDepth ?? 0;
    if (depth > WASH_MIN_DEPTH_M) {
      const rinse = WASH_PER_S * Math.min(1, depth / WASH_DEPTH_M) * (1 + speed / WASH_SPEED_MS) * dt;
      dirt.level *= Math.max(0, 1 - rinse);
      return;
    }
    let flungM = 0;
    for (const wheel of vehicle.wheelInfos) {
      if (wheel.isInContact) flungM += wheel.dirt * Math.abs(wheel.spinSpeed) * dt;
    }
    flungM /= Math.max(1, vehicle.wheelInfos.length);
    const gain = flungM * FLING_PER_M + speed * dt * GRIME_PER_M;
    dirt.level += (1 - dirt.level) * gain;
  }

  return dirt;
}

const isPaint = (material) => !!material?.userData.solidPaint;
const patchedMaterials = new WeakSet();

/** Bakes body-space coords into the painted meshes of `group` and hooks their paint into the dirt shader. */
function patchPaint(group, part, uniform, scratchUniforms) {
  group.updateMatrixWorld(true);
  const toGroup = group.matrixWorld.clone().invert();
  const toBody = new THREE.Matrix4();
  const point = new THREE.Vector3();
  const baked = [];
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  group.traverse((obj) => {
    if (!obj.isMesh) return;
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    if (!materials.some(isPaint)) return;
    // Shared geometry (another mesh, another car) gets its own copy for this mesh's coords.
    if (obj.geometry.getAttribute('dirtCoord')) obj.geometry = obj.geometry.clone();
    const position = obj.geometry.getAttribute('position');
    const coords = new Float32Array(position.count * 4);
    toBody.multiplyMatrices(toGroup, obj.matrixWorld);
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(toBody);
      coords[i * 4] = point.x + part * PART_OFFSET_M;
      coords[i * 4 + 1] = point.y;
      coords[i * 4 + 2] = point.z;
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
      minZ = Math.min(minZ, point.z);
      maxZ = Math.max(maxZ, point.z);
    }
    baked.push({ geometry: obj.geometry, coords });
    for (const material of materials) if (isPaint(material)) patchMaterial(material, uniform, scratchUniforms);
  });
  // w = height up the body, 0 at the sills .. 1 on the roof; dirtRear = 0 at the nose .. 1 at the tail (-z).
  const span = Math.max(1e-3, maxY - minY);
  const length = Math.max(1e-3, maxZ - minZ);
  for (const { geometry, coords } of baked) {
    const rear = new Float32Array(coords.length / 4);
    for (let i = 0; i < coords.length; i += 4) {
      coords[i + 3] = (coords[i + 1] - minY) / span;
      rear[i / 4] = (maxZ - coords[i + 2]) / length;
    }
    geometry.setAttribute('dirtCoord', new THREE.BufferAttribute(coords, 4));
    geometry.setAttribute('dirtRear', new THREE.BufferAttribute(rear, 1));
  }
}

function patchMaterial(material, uniform, scratchUniforms) {
  if (patchedMaterials.has(material)) return;
  patchedMaterials.add(material);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, scratchUniforms);
    shader.uniforms.dirtLevel = uniform;
    shader.uniforms.dirtDustColor = { value: DUST_COLOR };
    shader.uniforms.dirtMudColor = { value: MUD_COLOR };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 dirtCoord;\nattribute float dirtRear;\nvarying vec4 vDirtCoord;\nvarying float vDirtRear;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDirtCoord = dirtCoord;\nvDirtRear = dirtRear;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DIRT_FRAGMENT_HEAD}\n${SCRATCH_FRAGMENT_HEAD}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${SCRATCH_COLOR_FRAGMENT}\n${DIRT_COLOR_FRAGMENT}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${SCRATCH_ROUGHNESS_FRAGMENT}\nroughnessFactor = mix(roughnessFactor, 0.95, dirtCover);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${SCRATCH_METALNESS_FRAGMENT}\nmetalnessFactor *= 1.0 - dirtCover;`)
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
          ${SCRATCH_CLEARCOAT_FRAGMENT}
          material.clearcoat *= 1.0 - max(dirtMud, dirtLevel * 0.85);
          material.clearcoatRoughness = mix(material.clearcoatRoughness, 0.7, dirtLevel);
        #endif`
      );
  };
  material.needsUpdate = true;
}

const DIRT_FRAGMENT_HEAD = /* glsl */ `
uniform float dirtLevel;
uniform vec3 dirtDustColor;
uniform vec3 dirtMudColor;
varying vec4 vDirtCoord;
varying float vDirtRear;
float dirtHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float dirtNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(dirtHash(i), dirtHash(i + vec3(1, 0, 0)), f.x), mix(dirtHash(i + vec3(0, 1, 0)), dirtHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(dirtHash(i + vec3(0, 0, 1)), dirtHash(i + vec3(1, 0, 1)), f.x), mix(dirtHash(i + vec3(0, 1, 1)), dirtHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}`;

// Mud reaches higher up the body as the level rises, highest on the tail (the wake sucks the
// spray onto it); the film dulls it all, more low down and at the back. Mud tone: thin edges
// dried light, thick cores dark and wet, blotched by finer noise.
const DIRT_COLOR_FRAGMENT = /* glsl */ `
float dirtLow = 1.0 - vDirtCoord.w;
float dirtBack = smoothstep(0.45, 1.0, vDirtRear);
float dirtN = 0.65 * dirtNoise(vDirtCoord.xyz * 4.0) + 0.35 * dirtNoise(vDirtCoord.xyz * 13.0);
float dirtReach = dirtLevel * (0.25 + 1.25 * dirtLow * dirtLow) * (1.0 + 1.2 * dirtBack);
float dirtMud = dirtLevel > 0.0 ? smoothstep(1.0 - dirtReach, 1.15 - dirtReach, dirtN) : 0.0;
float dirtThick = smoothstep(1.1 - dirtReach, 1.45 - dirtReach, dirtN);
float dirtShade = 0.6 * dirtNoise(vDirtCoord.xyz * 9.0 + 31.0) + 0.4 * dirtNoise(vDirtCoord.xyz * 27.0 + 17.0);
vec3 dirtMudTone = mix(mix(dirtMudColor, dirtDustColor, 0.45), dirtMudColor * 0.65, dirtThick) * mix(0.7, 1.3, dirtShade);
diffuseColor.rgb = mix(diffuseColor.rgb, dirtDustColor, min(1.0, dirtLevel * (0.25 + 0.25 * dirtLow + 0.3 * dirtBack)));
diffuseColor.rgb = mix(diffuseColor.rgb, dirtMudTone, dirtMud * 0.9);
float dirtCover = max(dirtMud, dirtLevel * 0.6);`;
