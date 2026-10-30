import * as THREE from 'three';
import { getAirTempC } from '../lib/weather.js';

// Whole-frame colour grade, done in the full-screen copy of the scene target (no extra pass):
// overcast and fog mute saturation and contrast, cold air cools the white balance, hot air warms it.

const OVERCAST_DESATURATE = 0.15; // share of saturation lost under a full deck
const OVERCAST_FLATTEN = 0.01; // share of contrast lost under a full deck
const CONTRAST_PIVOT = 0.18; // linear mid grey
const COLD_FROM_C = 8; // neutral between these two
const WARM_FROM_C = 15;
const COLD_FULL_C = -10;
const WARM_FULL_C = 35;
const COOL_GAIN = new THREE.Vector3(0.74, 0.94, 1.32);
const WARM_GAIN = new THREE.Vector3(1.26, 1.03, 0.64);
const TEMP_EASE_SEC = 4; // forecast temps jump; ease the tint over a few seconds

/** -1 full cold .. 0 neutral .. 1 full warm. */
function tintForTemp(tempC) {
  if (tempC < COLD_FROM_C) return -Math.min(1, (COLD_FROM_C - tempC) / (COLD_FROM_C - COLD_FULL_C));
  if (tempC > WARM_FROM_C) return Math.min(1, (tempC - WARM_FROM_C) / (WARM_FULL_C - WARM_FROM_C));
  return 0;
}

/** Copy material for `map` with the grade applied; call update() once per frame before drawing. */
export function createColorGrade(map) {
  const uniforms = {
    map: { value: map },
    desaturate: { value: 0 },
    flatten: { value: 0 },
    gain: { value: new THREE.Vector3(1, 1, 1) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    defines: { GRADE: '' },
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform float desaturate;
      uniform float flatten;
      uniform vec3 gain;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(map, vUv).rgb;
        #ifdef GRADE
        float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(c, vec3(luma), desaturate);
        c = max(mix(c, vec3(${CONTRAST_PIVOT}), flatten), 0.0);
        c *= gain;
        #endif
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });

  let overcast = 0;
  let fog = 0;
  let tint = tintForTemp(getAirTempC());
  let lastMs = performance.now();
  let enabled = true;

  function update() {
    if (!enabled) return;
    const now = performance.now();
    const dt = Math.min(1, (now - lastMs) / 1000);
    lastMs = now;
    tint += (tintForTemp(getAirTempC()) - tint) * (1 - Math.exp(-dt / TEMP_EASE_SEC));
    const mute = Math.max(overcast, fog);
    uniforms.desaturate.value = mute * OVERCAST_DESATURATE;
    uniforms.flatten.value = mute * OVERCAST_FLATTEN;
    const target = tint < 0 ? COOL_GAIN : WARM_GAIN;
    uniforms.gain.value.set(1, 1, 1).lerp(target, Math.abs(tint));
  }

  return {
    material,
    update,
    /** Cloud deck cover 0..1 (clouds.js). */
    setOvercast(share) {
      overcast = share;
    },
    /** Fog grey share 0..1 (daylight.js). */
    setFog(share) {
      fog = share;
    },
    /** Graphics detail: off = a plain copy. */
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      material.defines = on ? { GRADE: '' } : {};
      material.needsUpdate = true;
      lastMs = performance.now();
    },
  };
}
