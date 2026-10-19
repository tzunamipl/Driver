// Suspension HUD: one bar per vehicle.wheelInfos entry (labels from
// vehicle.wheelLabels), so it works for 4-wheel cars and pod racers.
import { isWheelGrounded } from '../lib/wheelContact.js';
import { classifySurfaceAt } from '../lib/terrainSurface.js';
import { DEFAULT_SURFACE_KEY } from '../lib/surfaceCompounds.js';

// Fill colour: blue when airborne (own ground raycast, wheelContact.js),
// else green -> amber -> red by wheel.gripFraction (red = sliding).
const WHEEL_OFF_GROUND_COLOR = '#4fc3ff';
const GRIP_COLOR_STOPS = [
  [0, [76, 175, 80]], // green - comfortably within grip
  [0.7, [255, 193, 7]], // amber - approaching the limit
  [1, [244, 67, 54]], // red - at/over the limit (sliding)
];

// Terrain-type square colours (categorical).
const TERRAIN_COLOR_GENERIC = '#4caf50';
const TERRAIN_COLOR_ROAD = '#e53935';
const TERRAIN_COLOR_WATER = '#2196f3';
const TERRAIN_COLOR_BUILT_UP = '#ff9800';

function gripFractionToColor(fraction) {
  const f = Math.min(1, Math.max(0, fraction));
  let lo = GRIP_COLOR_STOPS[0];
  let hi = GRIP_COLOR_STOPS[GRIP_COLOR_STOPS.length - 1];
  for (let i = 0; i < GRIP_COLOR_STOPS.length - 1; i++) {
    if (f >= GRIP_COLOR_STOPS[i][0] && f <= GRIP_COLOR_STOPS[i + 1][0]) {
      lo = GRIP_COLOR_STOPS[i];
      hi = GRIP_COLOR_STOPS[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0] || 1;
  const t = (f - lo[0]) / span;
  const [r1, g1, b1] = lo[1];
  const [r2, g2, b2] = hi[1];
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Terrain type at (x, z) via terrainSurface.js ('normal' shown as 'generic'). */
function classifyTerrainAt(x, z, layers) {
  const surface = classifySurfaceAt(x, z, layers);
  return surface === DEFAULT_SURFACE_KEY ? 'generic' : surface;
}

function terrainColor(kind) {
  if (kind === 'road') return TERRAIN_COLOR_ROAD;
  if (kind === 'water') return TERRAIN_COLOR_WATER;
  if (kind === 'builtUp') return TERRAIN_COLOR_BUILT_UP;
  return TERRAIN_COLOR_GENERIC;
}

export function createSuspensionHud() {
  const grid = document.getElementById('susp-grid');
  const landedVal = document.getElementById('susp-landed-val');
  // Rebuilt when the wheel count/labels signature changes.
  let bars = [];
  let lastSignature = '';

  function rebuildBars(wheelInfos, labels) {
    grid.innerHTML = '';
    bars = wheelInfos.map((_, i) => {
      const label = labels?.[i] ?? String(i);
      const wheelEl = document.createElement('div');
      wheelEl.className = 'susp-wheel';
      wheelEl.innerHTML =
        '<div class="susp-terrain"></div>' +
        '<div class="susp-bar"><div class="susp-rest-line"></div><div class="susp-fill"></div></div>' +
        `<div class="susp-label">${label} <span class="susp-val">&mdash;</span></div>`;
      grid.appendChild(wheelEl);
      return {
        terrain: wheelEl.querySelector('.susp-terrain'),
        fill: wheelEl.querySelector('.susp-fill'),
        val: wheelEl.querySelector('.susp-val'),
      };
    });
  }

  /**
   * Fill: 0% full droop .. 100% bottomed out, rest marker at 50%; colour
   * as above. Square above each bar: terrain type under that wheel.
   */
  function updateSuspensionHud(vehicle, debugVisualsEnabled, hasLanded, world, terrainLayers) {
    if (!debugVisualsEnabled || !vehicle) return;

    const signature = `${vehicle.wheelInfos.length}:${vehicle.wheelLabels?.join(',') ?? ''}`;
    if (signature !== lastSignature) {
      rebuildBars(vehicle.wheelInfos, vehicle.wheelLabels);
      lastSignature = signature;
    }

    vehicle.wheelInfos.forEach((wheel, i) => {
      const { terrain, fill, val } = bars[i];
      const minLength = wheel.suspensionRestLength - wheel.maxSuspensionTravel;
      const maxLength = wheel.suspensionRestLength + wheel.maxSuspensionTravel;
      const span = maxLength - minLength || 1;
      const clampedLength = Math.min(maxLength, Math.max(minLength, wheel.suspensionLength));
      const compressionFrac = (maxLength - clampedLength) / span;
      const grounded = isWheelGrounded(world, wheel);
      const gripFraction = wheel.sliding ? 1 : wheel.gripFraction ?? 0;

      fill.style.height = `${Math.round(compressionFrac * 100)}%`;
      fill.style.background = grounded ? gripFractionToColor(gripFraction) : WHEEL_OFF_GROUND_COLOR;
      val.textContent = grounded ? `${Math.round(compressionFrac * 100)}%` : 'air';

      const pos = wheel.worldTransform.position;
      terrain.style.background = terrainColor(classifyTerrainAt(pos.x, pos.z, terrainLayers));
    });

    if (landedVal) landedVal.textContent = hasLanded ? 'true' : 'false';
  }

  return { updateSuspensionHud, el: document.getElementById('suspension-hud') };
}


