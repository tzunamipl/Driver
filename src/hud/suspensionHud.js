// Suspension travel HUD: one vertical bar per wheel/hover-point showing
// live spring travel, read straight from each entry's Cannon-es-style
// WheelInfo. Self-contained widget, independent of the other HUDs and of
// physics tuning. Bars are built dynamically from vehicle.wheelInfos (in
// order) and labelled from vehicle.wheelLabels (falling back to a plain
// index if a vehicle kind doesn't provide one) - so this one HUD works
// unmodified for lib/car.js's 4 fixed wheels (FL/FR/RL/RR) and for
// lib/chariot.js's variable engine count + pod (E1/E2/.../POD), instead of
// being hardcoded to exactly 4 wheels.
import { isWheelGrounded } from '../lib/wheelContact.js';
import { classifySurfaceAt } from '../lib/terrainSurface.js';
import { DEFAULT_SURFACE_KEY } from '../lib/surfaceCompounds.js';

// Debug-mode wheel colouring: blue while a wheel is off the ground
// (matching the "hasLanded" readout below, which reflects the scoring
// module's own touched-ground gate rather than any single wheel). Ground
// contact here is verified with its own world-down raycast (see
// wheelContact.js) rather than trusting cannon-es's own `wheel.isInContact`,
// which under-reports contact on real terrain.
//
// While grounded, the fill instead fades from green (plenty of grip in
// hand) through yellow/orange (approaching the tyre's friction limit) to
// red (actually sliding, i.e. demanded forward+lateral impulse exceeded
// maxGrip this step) - driven by wheel.gripFraction/wheel.sliding, both
// computed every physics step in wheeledVehicle.js's applyFriction() from
// the same friction-circle solve that drives the actual physics (not a
// separate/approximate readout).
const WHEEL_OFF_GROUND_COLOR = '#4fc3ff';
const GRIP_COLOR_STOPS = [
  [0, [76, 175, 80]], // green - comfortably within grip
  [0.7, [255, 193, 7]], // amber - approaching the limit
  [1, [244, 67, 54]], // red - at/over the limit (sliding)
];

// Terrain-type square colours (see the square's doc comment below):
// generic ground is the same green as "plenty of grip" above since both
// read as "normal" at a glance; road and water get their own unambiguous
// colours instead of a gradient, since terrain type is categorical, not a
// continuous quantity.
const TERRAIN_COLOR_GENERIC = '#4caf50';
const TERRAIN_COLOR_ROAD = '#e53935';
const TERRAIN_COLOR_WATER = '#2196f3';

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

/**
 * Classifies a world (x, z) position's terrain type for the debug square
 * (see rebuildBars/updateSuspensionHud below) via lib/terrainSurface.js's
 * shared classifySurfaceAt (same priority/fallback this HUD originally
 * defined: road first - "on road and water" counts as road - then water,
 * else the generic/default surface, which this HUD displays as "generic"
 * rather than terrainSurface.js's internal 'normal' key), also used by
 * lib/wheeledVehicle.js's per-surface tyre grip so the two can't drift out
 * of sync.
 */
function classifyTerrainAt(x, z, layers) {
  const surface = classifySurfaceAt(x, z, layers);
  return surface === DEFAULT_SURFACE_KEY ? 'generic' : surface;
}

function terrainColor(kind) {
  if (kind === 'road') return TERRAIN_COLOR_ROAD;
  if (kind === 'water') return TERRAIN_COLOR_WATER;
  return TERRAIN_COLOR_GENERIC;
}

export function createSuspensionHud() {
  const grid = document.getElementById('susp-grid');
  const landedVal = document.getElementById('susp-landed-val');
  // Rebuilt lazily whenever the attached vehicle's wheel count/labels
  // change (e.g. switching between a car and a pod racer) rather than on
  // every frame - tracked by a simple signature string.
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
   * A bar's fill height is 0% at full droop (fully extended) and 100% at
   * full compression (bottomed out), with a rest-length marker line fixed
   * at 50% - so the fill visibly moves up as a wheel loads/compresses
   * (cornering, braking, bumps) and down as it unloads/droops (cresting a
   * bump, airborne). The fill colour flags ground contact directly: blue
   * while the wheel is off the ground, else a green->amber->red gradient
   * driven by how close that wheel's tyre is to its friction limit (red
   * once it's actually sliding). The small square above each bar is a
   * separate, independent readout: the terrain type directly under that
   * wheel's (x, z) position (green = generic ground, red = road, blue =
   * water - see classifyTerrainAt above), regardless of whether the wheel
   * is actually touching the ground right now.
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


