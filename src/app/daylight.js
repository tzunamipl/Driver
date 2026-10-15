import * as THREE from 'three';
import { sunDirection } from '../lib/sunPosition.js';
import { setHazeColor } from '../lib/terrain.js';
import { setPaintReflection } from '../lib/vehicles/geometry/paint.js';
import { TIME_SCALE } from '../config.js';

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

// Palette by sun elevation (deg), linearly interpolated. Night keeps a
// bluish ambient floor so the map stays drivable; moonI is the moonlight.
const PALETTE = [
  { el: -12, sky: 0x0a1020, fog: 0x080c16, sun: 0xff6a30, sunI: 0, moonI: 0.6, amb: 0x7080b0, ambI: 0.42, disc: 0xff6a30 },
  { el: -6, sky: 0x1c2848, fog: 0x141c30, sun: 0xff6a30, sunI: 0, moonI: 0.45, amb: 0x8a8fb8, ambI: 0.45, disc: 0xff6a30 },
  { el: -1, sky: 0x9a7088, fog: 0x4a4050, sun: 0xff6a30, sunI: 0, moonI: 0, amb: 0xa898b0, ambI: 0.45, disc: 0xff6a30 },
  { el: 2, sky: 0xe8a07a, fog: 0x7a6050, sun: 0xff8844, sunI: 1.4, moonI: 0, amb: 0xe0c0b0, ambI: 0.4, disc: 0xff8a40 },
  { el: 8, sky: 0xa8c8e0, fog: 0x3a5058, sun: 0xffd8a8, sunI: 2.6, moonI: 0, amb: 0xffffff, ambI: 0.4, disc: 0xffd070 },
  { el: 20, sky: 0x87ceeb, fog: 0x38616b, sun: 0xffffff, sunI: 3.2, moonI: 0, amb: 0xffffff, ambI: 0.4, disc: 0xffee88 },
].map((k) => ({
  ...k,
  sky: new THREE.Color(k.sky),
  fog: new THREE.Color(k.fog),
  sun: new THREE.Color(k.sun),
  amb: new THREE.Color(k.amb),
  disc: new THREE.Color(k.disc),
}));

/**
 * Simulated clock: real time since UTC midnight times TIME_SCALE, wrapped
 * inside the real (UTC) date - a pure function of wall time, so reloads agree.
 */
function simulatedTimeMs(realMs) {
  const dayStart = realMs - (realMs % MS_PER_DAY);
  return dayStart + ((realMs - dayStart) * TIME_SCALE) % MS_PER_DAY;
}

export function createDaylight({ scene, sun, ambient, sunDisc, moonDisc }) {
  const sunDir = new THREE.Vector3();
  const lightDir = new THREE.Vector3();
  const sky = new THREE.Color();

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
    sunDisc.material.color.lerpColors(a.disc, b.disc, t);
  }

  /** Call once per frame with the car's world position and lat/lon. */
  function update(position, lat, lon) {
    const { east, north, up } = sunDirection(simulatedTimeMs(Date.now()), lat, lon);
    // World axes: x = east, y = up, z = south.
    sunDir.set(east, up, -north);
    const elevationDeg = Math.asin(THREE.MathUtils.clamp(up, -1, 1)) / (Math.PI / 180);

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
  }

  return { update };
}
