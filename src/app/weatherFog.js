import * as THREE from 'three';
import { getRainMmH, getVisibilityM, NO_FOG_VISIBILITY_M } from '../lib/weather.js';
import { setFogFar } from '../lib/terrain.js';

// Weather fog from lib/weather.js visibility, or the rain's haze if thicker. Objects (scene.fog, linear) and the ground / clouds
// (terrain.js setFogFar) fade the same way: linearly from the camera, gone at the fog's far distance.
// daylight.js greys the sky, dims the sun and pulls the object fog colour to the sky by the shares returned.

const CLEAR_VISIBILITY_M = 12_000; // no fog at or above
const FULL_FOG_VISIBILITY_M = 2_000; // far distance = the visibility at or below; between, it stretches out to infinity
const DIM_FROM_M = 3_000; // sky greyed and sun dimmed from this visibility...
const DIM_FULL_M = 200; // ...fully at this
const EASE_SEC = 3; // forecast steps and debug picks roll in
// Rain haze: none below RAIN_HAZE_FROM_MM_H, mist (RAIN_HAZE_FULL_M) at RAIN_HAZE_FULL_MM_H and up, log-scaled between.
const RAIN_HAZE_FROM_MM_H = 0.5;
const RAIN_HAZE_FULL_MM_H = 10;
const RAIN_HAZE_FULL_M = 2_000;

/** Visibility (m) through rain of `mmH` alone. */
export function rainVisibilityM(mmH) {
  if (!(mmH > RAIN_HAZE_FROM_MM_H)) return NO_FOG_VISIBILITY_M;
  const t = Math.min(1, Math.log(mmH / RAIN_HAZE_FROM_MM_H) / Math.log(RAIN_HAZE_FULL_MM_H / RAIN_HAZE_FROM_MM_H));
  return Math.exp(THREE.MathUtils.lerp(Math.log(CLEAR_VISIBILITY_M), Math.log(RAIN_HAZE_FULL_M), t));
}

const currentVisibilityM = () => Math.min(getVisibilityM(), rainVisibilityM(getRainMmH()), NO_FOG_VISIBILITY_M);

/** Distance (m) where fog of visibility `m` hides everything; Infinity = no fog. */
function fogFarM(m) {
  const strength = THREE.MathUtils.clamp((CLEAR_VISIBILITY_M - m) / (CLEAR_VISIBILITY_M - FULL_FOG_VISIBILITY_M), 0, 1);
  return strength > 0 ? m / strength : Infinity;
}

/** @param {THREE.Fog} fog - scene.fog; its near / far at creation are the no-fog distances. */
export function createWeatherFog(fog) {
  const baseNear = fog.near;
  const baseFar = fog.far;
  let logVisibility = Math.log(currentVisibilityM());
  let lastMs = performance.now();
  const shares = { dim: 0, tint: 0 };

  /**
   * Per frame: eases towards the current visibility, sets the fog distances.
   * @returns {{ dim: number, tint: number }} dim = light / sky grey share, tint = share of the object fog colour taken from the sky.
   */
  function update() {
    const now = performance.now();
    const dt = Math.min(1, (now - lastMs) / 1000);
    lastMs = now;
    logVisibility += (Math.log(currentVisibilityM()) - logVisibility) * (1 - Math.exp(-dt / EASE_SEC));
    const m = Math.exp(logVisibility);
    const far = fogFarM(m);
    setFogFar(far);
    // Thinning out: the near end slides back to the no-fog one over one more base far.
    const out = THREE.MathUtils.clamp((far - baseFar) / baseFar, 0, 1);
    fog.near = baseNear * out;
    fog.far = Math.min(far, baseFar);
    shares.tint = 1 - out;
    shares.dim = THREE.MathUtils.clamp(Math.log(DIM_FROM_M / m) / Math.log(DIM_FROM_M / DIM_FULL_M), 0, 1);
    return shares;
  }

  return { update };
}
