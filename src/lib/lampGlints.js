import * as THREE from 'three';

// Lamp glints: small emitters mirrored in the road surface view (streets.js) as specular highlights
// without being scene lights (each light costs every lit pixel; changing their count recompiles every
// shader). Slots 0-1 = the local car's head lamps, 2-3 its tail lamps (headlights.js); the rest go to the
// nearest emitters of the registered sources each frame. The head lamp slots also drive the
// retroreflective sign faces. Off (graphics detail below High), the road skips them and the car's pool
// spotlights glint on it as ordinary lights; the sign faces still use the head lamp slots.

export const GLINT_SLOTS = 16;
export const CAR_GLINT_SLOTS = 4;
const GLINT_RANGE_M = 150;
const RETRO_GAIN = 3; // retroreflective faces vs a plain diffuse one, towards the lamp
const RETRO_LOBE = 6; // how tightly the bounce stays on the lamp's line

const slots = (make) => ({ value: Array.from({ length: GLINT_SLOTS }, make) });
export const GLINT_UNIFORMS = {
  glintPos: slots(() => new THREE.Vector4()), // world xyz + intensity (0 = off)
  glintDir: slots(() => new THREE.Vector4()), // world aim + cutoff distance
  glintCone: slots(() => new THREE.Vector3()), // cos cone, cos penumbra, decay
  glintColor: slots(() => new THREE.Color()),
  carPoolPos: { value: [new THREE.Vector3(), new THREE.Vector3()] }, // headlights.js pool spotlights
  glintsOn: { value: 1 },
};

/** Uniforms + glintIrradiance(i, p, n, out l): slot i's irradiance at view-space p, normal n. Needs lights_pars_begin. */
export const GLINT_GLSL = `
uniform vec4 glintPos[${GLINT_SLOTS}];
uniform vec4 glintDir[${GLINT_SLOTS}];
uniform vec3 glintCone[${GLINT_SLOTS}];
uniform vec3 glintColor[${GLINT_SLOTS}];
uniform vec3 carPoolPos[2];
uniform float glintsOn;
float glintIrradiance(int i, vec3 p, vec3 n, out vec3 l) {
  vec4 lamp = glintPos[i];
  if (lamp.w <= 0.0) return 0.0;
  vec3 toLamp = (viewMatrix * vec4(lamp.xyz, 1.0)).xyz - p;
  float d = length(toLamp);
  l = toLamp / d;
  float cone = getSpotAttenuation(glintCone[i].x, glintCone[i].y, dot(l, -normalize(mat3(viewMatrix) * glintDir[i].xyz)));
  return lamp.w * cone * getDistanceAttenuation(d, glintDir[i].w, glintCone[i].z) * saturate(dot(n, l));
}`;

/** Spot cone as three.js SpotLight uniforms have it: cos cone, cos penumbra, decay. */
export function glintCone(angle, penumbra, decay) {
  return new THREE.Vector3(Math.cos(angle), Math.cos(angle * (1 - penumbra)), decay);
}

/** Fills slot `i`; position / aim are world {x, y, z}, aim normalised. */
export function setGlint(i, position, aim, cone, distance, intensity, color) {
  GLINT_UNIFORMS.glintPos.value[i].set(position.x, position.y, position.z, intensity);
  GLINT_UNIFORMS.glintDir.value[i].set(aim.x, aim.y, aim.z, distance);
  GLINT_UNIFORMS.glintCone.value[i].copy(cone);
  GLINT_UNIFORMS.glintColor.value[i].copy(color);
}

export function clearGlint(i) {
  GLINT_UNIFORMS.glintPos.value[i].w = 0;
}

/** JS twin of glintIrradiance for slot i at world point p facing `normal` (both {x, y, z}). */
export function glintIrradianceAt(i, p, normal) {
  const lamp = GLINT_UNIFORMS.glintPos.value[i];
  if (lamp.w <= 0) return 0;
  const dir = GLINT_UNIFORMS.glintDir.value[i];
  const [coneCos, penumbraCos, decay] = GLINT_UNIFORMS.glintCone.value[i].toArray();
  const lx = lamp.x - p.x;
  const ly = lamp.y - p.y;
  const lz = lamp.z - p.z;
  const d = Math.hypot(lx, ly, lz);
  if (d < 1e-3 || d >= dir.w) return 0;
  const angleCos = -(lx * dir.x + ly * dir.y + lz * dir.z) / d;
  const cone = THREE.MathUtils.smoothstep(angleCos, coneCos, penumbraCos);
  const window = Math.max(0, 1 - (d / dir.w) ** 4) ** 2;
  const facing = Math.max(0, (lx * normal.x + ly * normal.y + lz * normal.z) / d);
  return (lamp.w * cone * window * facing) / Math.max(d ** decay, 0.01);
}

/** Retroreflective faces: bright where the local car's head lamps hit them, seen from near the lamps. */
export function makeRetroreflective(material) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, GLINT_UNIFORMS);
    shader.fragmentShader = shader.fragmentShader.replace('void main() {', `${GLINT_GLSL}\nvoid main() {`).replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      for (int i = 0; i < 2; i++) {
        vec3 l;
        float e = glintIrradiance(i, geometryPosition, geometryNormal, l);
        if (e > 0.0) totalEmissiveRadiance += diffuseColor.rgb * glintColor[i] * (e * ${RETRO_GAIN.toFixed(2)} * RECIPROCAL_PI * pow(saturate(dot(geometryViewDir, l)), ${RETRO_LOBE.toFixed(1)}));
      }`
    );
  };
  material.customProgramCacheKey = () => 'retroreflective';
  return material;
}

/** Graphics detail: road glints on / off. */
export function setGlintsEnabled(on) {
  GLINT_UNIFORMS.glintsOn.value = on ? 1 : 0;
}

// (add, x, z, rangeSq) => void; add(position, aim, cone, distance, intensity, color) per lit emitter.
const sources = new Set();

/** Registers an emitter source; returns its removal. */
export function addGlintSource(source) {
  sources.add(source);
  return () => sources.delete(source);
}

/** Once per frame after the car's lamps: the nearest emitters to (x, z) take the free slots. */
export function updateGlints(x, z) {
  const found = [];
  if (!GLINT_UNIFORMS.glintsOn.value) {
    for (let i = CAR_GLINT_SLOTS; i < GLINT_SLOTS; i++) clearGlint(i);
    return;
  }
  const add = (position, aim, cone, distance, intensity, color) => {
    if (intensity > 0) found.push({ position, aim, cone, distance, intensity, color, d: (position.x - x) ** 2 + (position.z - z) ** 2 });
  };
  for (const source of sources) source(add, x, z, GLINT_RANGE_M ** 2);
  found.sort((a, b) => a.d - b.d);
  for (let i = CAR_GLINT_SLOTS; i < GLINT_SLOTS; i++) {
    const g = found[i - CAR_GLINT_SLOTS];
    if (g) setGlint(i, g.position, g.aim, g.cone, g.distance, g.intensity, g.color);
    else clearGlint(i);
  }
}
