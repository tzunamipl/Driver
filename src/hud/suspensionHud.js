// Suspension HUD: one bar per vehicle.wheelInfos entry (labels from
// vehicle.wheelLabels), so it works for 4-wheel cars and pod racers.
// Under each bar: shock health and hardest strike (any grounded step) in the last
// STRIKE_WINDOW_MS (shocks.js); below: debug Wear / Fix.
import { isWheelGrounded } from '../lib/wheelContact.js';
import { classifySurfaceAt } from '../lib/terrainSurface.js';
import { DEFAULT_SURFACE_KEY } from '../lib/surfaceCompounds.js';
import { setShockHealth, HIT_MIN_MS } from '../lib/shocks.js';

// Fill colour: blue when airborne (own ground raycast, wheelContact.js),
// else green -> amber -> red by wheel.gripFraction (red = sliding).
const WHEEL_OFF_GROUND_COLOR = '#4fc3ff';
const GRIP_COLOR_STOPS = [
  [0, [76, 175, 80]], // green - comfortably within grip
  [0.7, [255, 193, 7]], // amber - approaching the limit
  [1, [244, 67, 54]], // red - at/over the limit (sliding)
];

// Shock health shown in red below this.
const WORN_SHOCK = 0.5;
const DEBUG_SHOCK_WEAR = 0.25;
const STRIKE_WINDOW_MS = 10000;

// Terrain-type square colours (categorical).
const TERRAIN_COLOR_GENERIC = '#4caf50';
const TERRAIN_COLOR_ROAD = '#e53935';
const TERRAIN_COLOR_UNPAVED = '#a1887f';
const TERRAIN_COLOR_WATER = '#2196f3';
const TERRAIN_COLOR_BUILT_UP = '#ff9800';
const TERRAIN_COLOR_FOREST = '#1b5e20';
const TERRAIN_COLOR_ROCK = '#78909c';
const TERRAIN_COLOR_ICE = '#e1f5fe';
const TERRAIN_COLOR_SCRUB = '#827717';
const TERRAIN_COLOR_SAND = '#ffe082';

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
  if (kind === 'unpaved') return TERRAIN_COLOR_UNPAVED;
  if (kind === 'water') return TERRAIN_COLOR_WATER;
  if (kind === 'builtUp') return TERRAIN_COLOR_BUILT_UP;
  if (kind === 'forest') return TERRAIN_COLOR_FOREST;
  if (kind === 'rock') return TERRAIN_COLOR_ROCK;
  if (kind === 'ice') return TERRAIN_COLOR_ICE;
  if (kind === 'scrub') return TERRAIN_COLOR_SCRUB;
  if (kind === 'sand') return TERRAIN_COLOR_SAND;
  return TERRAIN_COLOR_GENERIC;
}

export function createSuspensionHud() {
  const grid = document.getElementById('susp-grid');
  const landedVal = document.getElementById('susp-landed-val');
  let vehicle = null;
  // Blur so Space / arrows (driving keys) don't keep working the focused button.
  function onClick(id, action) {
    const button = document.getElementById(id);
    button?.addEventListener('click', () => {
      if (vehicle) action(vehicle);
      button.blur();
    });
  }
  onClick('susp-shock-hit', (v) => v.wheelInfos.forEach((w) => w.shockHealth !== undefined && setShockHealth(w, w.shockHealth - DEBUG_SHOCK_WEAR)));
  onClick('susp-shock-fix', (v) => v.repairShocks?.());
  // Rebuilt when the wheel count/labels signature changes.
  let bars = [];
  let lastSignature = '';
  // Per wheel: [{ t, speed }] strikes within STRIKE_WINDOW_MS.
  let strikeLogs = [];

  /** Drains each shock's strike peak into its log, even while the HUD is hidden. */
  function logStrikes(wheelInfos) {
    const now = performance.now();
    if (strikeLogs.length !== wheelInfos.length) strikeLogs = wheelInfos.map(() => []);
    wheelInfos.forEach((wheel, i) => {
      const log = strikeLogs[i];
      if (wheel.shockStrikeMax > 0) {
        log.push({ t: now, speed: wheel.shockStrikeMax });
        wheel.shockStrikeMax = 0;
      }
      while (log.length && now - log[0].t > STRIKE_WINDOW_MS) log.shift();
    });
  }

  function rebuildBars(wheelInfos, labels) {
    grid.innerHTML = '';
    bars = wheelInfos.map((_, i) => {
      const label = labels?.[i] ?? String(i);
      const wheelEl = document.createElement('div');
      wheelEl.className = 'susp-wheel';
      wheelEl.innerHTML =
        '<div class="susp-terrain"></div>' +
        '<div class="susp-bar"><div class="susp-rest-line"></div><div class="susp-fill"></div></div>' +
        `<div class="susp-label">${label} <span class="susp-val">&mdash;</span></div>` +
        '<div class="susp-label susp-shock" title="Shock health"></div>' +
        `<div class="susp-label susp-shock susp-strike" title="Hardest strike in the last ${STRIKE_WINDOW_MS / 1000} s (m/s); red = above ${HIT_MIN_MS} m/s, which wears the shock if it is at the bump stop"></div>`;
      grid.appendChild(wheelEl);
      return {
        terrain: wheelEl.querySelector('.susp-terrain'),
        fill: wheelEl.querySelector('.susp-fill'),
        val: wheelEl.querySelector('.susp-val'),
        shock: wheelEl.querySelector('.susp-shock'),
        strike: wheelEl.querySelector('.susp-strike'),
      };
    });
  }

  /**
   * Fill: 0% full droop .. 100% bottomed out, rest marker at 50%; colour
   * as above. Square above each bar: terrain type under that wheel.
   */
  function updateSuspensionHud(nextVehicle, debugVisualsEnabled, hasLanded, world, terrainLayers) {
    if (!nextVehicle) return;
    if (nextVehicle !== vehicle) strikeLogs = [];
    logStrikes(nextVehicle.wheelInfos);
    if (!debugVisualsEnabled) {
      vehicle = nextVehicle;
      return;
    }
    vehicle = nextVehicle;

    const signature = `${vehicle.wheelInfos.length}:${vehicle.wheelLabels?.join(',') ?? ''}`;
    if (signature !== lastSignature) {
      rebuildBars(vehicle.wheelInfos, vehicle.wheelLabels);
      lastSignature = signature;
    }

    vehicle.wheelInfos.forEach((wheel, i) => {
      const { terrain, fill, val, shock, strike } = bars[i];
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

      const health = wheel.shockHealth;
      shock.textContent = health === undefined ? '' : `${Math.round(health * 100)}%`;
      shock.classList.toggle('worn', health < WORN_SHOCK);
      const peak = strikeLogs[i].reduce((max, s) => Math.max(max, s.speed), 0);
      strike.textContent = health === undefined ? '' : `${peak.toFixed(1)} m/s`;
      strike.classList.toggle('worn', peak > HIT_MIN_MS);

      const pos = wheel.worldTransform.position;
      terrain.style.background = terrainColor(classifyTerrainAt(pos.x, pos.z, terrainLayers));
    });

    if (landedVal) landedVal.textContent = hasLanded ? 'true' : 'false';
  }

  return { updateSuspensionHud, el: document.getElementById('suspension-hud') };
}


