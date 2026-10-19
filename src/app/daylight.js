import * as THREE from 'three';
import { sunDirection } from '../lib/sunPosition.js';
import { setHazeColor } from '../lib/terrain.js';
import { setPaintReflection } from '../lib/vehicles/geometry/paint.js';
import { setPuffTint } from '../lib/particles/puffPool.js';
import { TIME_SCALE, SUN_DISC_COLORS, MOON_DISC_COLORS } from '../config.js';

// Day-night cycle: sun direction from the simulated clock and the car's
// lat/lon, with sky, fog, haze and light colours keyed to sun elevation.
// The moon is kept exactly opposite the sun, so it is up whenever the sun
// is down; one directional light (one shadow map) serves both.

const MS_PER_DAY = 86_400_000;
// Within the shadow camera's near/far (sceneSetup.js) around the target.
const SUN_LIGHT_DISTANCE_M = 50;
const SUN_DISC_DISTANCE_M = 150_000; // inside the camera far plane
const SUN_DISC_MIN_ELEVATION_DEG = -2;
// Below this sun elevation the light switches to the moon; both palette
// intensities are 0 here, so the swap is invisible.
const MOON_TAKEOVER_ELEVATION_DEG = -1;
const MOON_LIGHT_COLOR = new THREE.Color(0x9fb4e0);
const MS_PER_HOUR = 3_600_000;
const SUNSET_ELEVATION_DEG = 1.5; // low enough for the orange palette, disc still above the horizon

// Palette by sun elevation (deg), linearly interpolated. Night keeps a
// bluish ambient floor so the map stays drivable; moonI is the moonlight.
const PALETTE = [
  { el: -12, sky: 0x0a1020, fog: 0x080c16, sun: 0xff6a30, sunI: 0, moonI: 0.6, amb: 0x7080b0, ambI: 0.42 },
  { el: -6, sky: 0x1c2848, fog: 0x141c30, sun: 0xff6a30, sunI: 0, moonI: 0.45, amb: 0x8a8fb8, ambI: 0.45 },
  { el: -1, sky: 0x9a7088, fog: 0x4a4050, sun: 0xff6a30, sunI: 0, moonI: 0, amb: 0xa898b0, ambI: 0.45 },
  { el: 2, sky: 0xe8a07a, fog: 0x7a6050, sun: 0xff8844, sunI: 1.4, moonI: 0, amb: 0xe0c0b0, ambI: 0.4 },
  { el: 8, sky: 0xa8c8e0, fog: 0x3a5058, sun: 0xffd8a8, sunI: 2.6, moonI: 0, amb: 0xffffff, ambI: 0.4 },
  { el: 20, sky: 0x87ceeb, fog: 0x38616b, sun: 0xffffff, sunI: 3.2, moonI: 0, amb: 0xffffff, ambI: 0.4 },
].map((k) => ({
  ...k,
  sky: new THREE.Color(k.sky),
  fog: new THREE.Color(k.fog),
  sun: new THREE.Color(k.sun),
  amb: new THREE.Color(k.amb),
}));

const toRamp = (keys) => keys.map((k) => ({ el: k.el, color: new THREE.Color(k.color) }));
const SUN_DISC_RAMP = toRamp(SUN_DISC_COLORS);
const MOON_DISC_RAMP = toRamp(MOON_DISC_COLORS);

/** Writes the ramp colour at `elevationDeg` into `out`. */
function sampleRamp(ramp, elevationDeg, out) {
  if (elevationDeg <= ramp[0].el) return out.copy(ramp[0].color);
  let i = 0;
  while (i < ramp.length - 2 && elevationDeg > ramp[i + 1].el) i++;
  const a = ramp[i];
  const b = ramp[i + 1] ?? a;
  const t = b === a ? 0 : THREE.MathUtils.clamp((elevationDeg - a.el) / (b.el - a.el), 0, 1);
  return out.lerpColors(a.color, b.color, t);
}

/**
 * Simulated clock: real time since UTC midnight times TIME_SCALE, wrapped
 * inside the real (UTC) date - a pure function of wall time, so reloads agree.
 */
function simulatedTimeMs(realMs) {
  const dayStart = realMs - (realMs % MS_PER_DAY);
  return dayStart + ((realMs - dayStart) * TIME_SCALE) % MS_PER_DAY;
}

/** Sun elevation (deg) at `timeMs` for lat/lon. */
function elevationAt(timeMs, lat, lon) {
  return Math.asin(THREE.MathUtils.clamp(sunDirection(timeMs, lat, lon).up, -1, 1)) / (Math.PI / 180);
}

/** Fixed simulated instant on the current simulated day for a debug preset ('noon' | 'sunset' | 'night'). */
function presetTimeMs(preset, lat, lon) {
  const now = simulatedTimeMs(Date.now());
  const dayStart = now - (now % MS_PER_DAY);
  // Solar noon ignoring the equation of time, then refined by a ternary search for peak elevation.
  let lo = dayStart + (12 - lon / 15) * MS_PER_HOUR - 2 * MS_PER_HOUR;
  let hi = lo + 4 * MS_PER_HOUR;
  for (let i = 0; i < 40; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (elevationAt(m1, lat, lon) < elevationAt(m2, lat, lon)) lo = m1;
    else hi = m2;
  }
  const noon = (lo + hi) / 2;
  if (preset === 'noon') return noon;
  if (preset === 'night') return noon + 12 * MS_PER_HOUR;
  // Sunset: elevation falls monotonically from noon to midnight; bisect for the target.
  lo = noon;
  hi = noon + 12 * MS_PER_HOUR;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (elevationAt(mid, lat, lon) > SUNSET_ELEVATION_DEG) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function createDaylight({ scene, sun, ambient, sunDisc, moonDisc, stars }) {
  const sunDir = new THREE.Vector3();
  const lightDir = new THREE.Vector3();
  const sky = new THREE.Color();
  // Debug time override: null = live cycle; otherwise a preset frozen at its instant.
  let preset = null;
  let presetMs = null;
  let sunElevationDeg = 90;

  function applyPalette(elevationDeg) {
    let i = 0;
    while (i < PALETTE.length - 2 && elevationDeg > PALETTE[i + 1].el) i++;
    const a = PALETTE[i];
    const b = PALETTE[i + 1];
    const t = THREE.MathUtils.clamp((elevationDeg - a.el) / (b.el - a.el), 0, 1);

    sky.lerpColors(a.sky, b.sky, t);
    scene.background.copy(sky);
    setHazeColor(sky);
    setPaintReflection(sky);
    scene.fog.color.lerpColors(a.fog, b.fog, t);
    if (elevationDeg < MOON_TAKEOVER_ELEVATION_DEG) {
      sun.color.copy(MOON_LIGHT_COLOR);
      sun.intensity = THREE.MathUtils.lerp(a.moonI, b.moonI, t);
    } else {
      sun.color.lerpColors(a.sun, b.sun, t);
      sun.intensity = THREE.MathUtils.lerp(a.sunI, b.sunI, t);
    }
    ambient.color.lerpColors(a.amb, b.amb, t);
    ambient.intensity = THREE.MathUtils.lerp(a.ambI, b.ambI, t);
    setPuffTint(ambient.color);
    sampleRamp(SUN_DISC_RAMP, elevationDeg, sunDisc.material.color);
    sampleRamp(MOON_DISC_RAMP, -elevationDeg, moonDisc.material.color);
  }

  /** Call once per frame with the car's world position and lat/lon. */
  function update(position, lat, lon) {
    if (preset && presetMs === null) presetMs = presetTimeMs(preset, lat, lon);
    const timeMs = preset ? presetMs : simulatedTimeMs(Date.now());
    const { east, north, up } = sunDirection(timeMs, lat, lon);
    // World axes: x = east, y = up, z = south.
    sunDir.set(east, up, -north);
    const elevationDeg = Math.asin(THREE.MathUtils.clamp(up, -1, 1)) / (Math.PI / 180);
    sunElevationDeg = elevationDeg;

    applyPalette(elevationDeg);

    // Keep the light and its shadow frustum centred on the car.
    lightDir.copy(sunDir);
    if (elevationDeg < MOON_TAKEOVER_ELEVATION_DEG) lightDir.negate();
    sun.position.copy(lightDir).multiplyScalar(SUN_LIGHT_DISTANCE_M).add(position);
    sun.target.position.copy(position);
    sun.target.updateMatrixWorld();
    sunDisc.position.copy(sunDir).multiplyScalar(SUN_DISC_DISTANCE_M).add(position);
    sunDisc.visible = elevationDeg > SUN_DISC_MIN_ELEVATION_DEG;
    moonDisc.position.copy(sunDir).multiplyScalar(-SUN_DISC_DISTANCE_M).add(position);
    moonDisc.visible = -elevationDeg > SUN_DISC_MIN_ELEVATION_DEG;
    stars.update(timeMs, lat, lon, position, elevationDeg);
  }

  /** Debug: freeze the clock at 'noon' | 'sunset' | 'night' for the current location, or null for the live cycle. */
  function setTimePreset(next) {
    preset = next;
    presetMs = null; // resolved on the next update, where lat/lon are known
  }

  return { update, setTimePreset, getTimePreset: () => preset, getSunElevation: () => sunElevationDeg };
}
