// Falling rain around the camera, as dense as lib/weather.js rainfall: streaks in a box that
// follows the camera, the drops wrapping inside it so they stay put in the world while it moves.
// One LineSegments, dimmed with the daylight; visual only.

import { BufferAttribute, BufferGeometry, DynamicDrawUsage, LineBasicMaterial, LineSegments } from 'three';
import { getRainMmH } from './weather.js';

const MAX_DROPS = 7000;
const BOX_M = 36; // across, centred on the camera
const BOX_HEIGHT_M = 22;
const FULL_MM_H = 8; // all drops drawn from this rainfall
const MIN_SHARE = 0.08; // the lightest drawn rain
const FALL_SPEED = 9; // m/s
const SPEED_JITTER = 0.15; // share
const WIND_X = 1.1; // m/s slant
const WIND_Z = 0.5;
const STREAK_S = 0.045; // streak length = velocity x this
const COLOR = 0xb8c4d0;
const OPACITY = 0.5;
// Sun elevation (deg) -> brightness: full by day, this share at night.
const NIGHT_SHARE = 0.3;
const DARK_EL = -10;
const LIGHT_EL = 8;

const wrap = (v, size) => ((v % size) + size) % size;

export function createRain(scene) {
  // Drop positions inside the box (world-wrapped) and each one's fall speed.
  const drops = new Float32Array(MAX_DROPS * 3);
  const speeds = new Float32Array(MAX_DROPS);
  for (let i = 0; i < MAX_DROPS; i++) {
    drops[i * 3] = Math.random() * BOX_M;
    drops[i * 3 + 1] = Math.random() * BOX_HEIGHT_M;
    drops[i * 3 + 2] = Math.random() * BOX_M;
    speeds[i] = FALL_SPEED * (1 + (Math.random() * 2 - 1) * SPEED_JITTER);
  }
  const positions = new Float32Array(MAX_DROPS * 6);
  const geometry = new BufferGeometry();
  const attr = new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', attr);
  const material = new LineBasicMaterial({ color: COLOR, transparent: true, opacity: OPACITY, depthWrite: false });
  const lines = new LineSegments(geometry, material);
  lines.frustumCulled = false;
  lines.visible = false;
  lines.renderOrder = 2;
  scene.add(lines);

  /** Per frame, after the camera moved. */
  function update(dt, cameraPos, sunElevationDeg) {
    const rain = getRainMmH();
    lines.visible = rain > 0;
    if (!lines.visible) return;
    const count = Math.round(MAX_DROPS * Math.min(1, MIN_SHARE + rain / FULL_MM_H));
    const light = Math.min(1, Math.max(0, (sunElevationDeg - DARK_EL) / (LIGHT_EL - DARK_EL)));
    material.opacity = OPACITY * (NIGHT_SHARE + (1 - NIGHT_SHARE) * light);
    const half = BOX_M / 2;
    const halfH = BOX_HEIGHT_M / 2;
    for (let i = 0; i < count; i++) {
      const k = i * 3;
      const v = speeds[i];
      drops[k] = wrap(drops[k] + WIND_X * dt, BOX_M);
      drops[k + 1] = wrap(drops[k + 1] - v * dt, BOX_HEIGHT_M);
      drops[k + 2] = wrap(drops[k + 2] + WIND_Z * dt, BOX_M);
      const x = cameraPos.x + wrap(drops[k] - cameraPos.x, BOX_M) - half;
      const y = cameraPos.y + wrap(drops[k + 1] - cameraPos.y, BOX_HEIGHT_M) - halfH;
      const z = cameraPos.z + wrap(drops[k + 2] - cameraPos.z, BOX_M) - half;
      const p = i * 6;
      positions[p] = x - WIND_X * STREAK_S;
      positions[p + 1] = y + v * STREAK_S;
      positions[p + 2] = z - WIND_Z * STREAK_S;
      positions[p + 3] = x;
      positions[p + 4] = y;
      positions[p + 5] = z;
    }
    geometry.setDrawRange(0, count * 2);
    attr.needsUpdate = true;
  }

  /** floatingOrigin.js: the drops move with the world. */
  function shiftOrigin(dx, dz) {
    for (let i = 0; i < MAX_DROPS; i++) {
      drops[i * 3] = wrap(drops[i * 3] - dx, BOX_M);
      drops[i * 3 + 2] = wrap(drops[i * 3 + 2] - dz, BOX_M);
    }
  }

  return { update, shiftOrigin };
}
