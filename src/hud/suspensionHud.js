// Suspension HUD: one bar per vehicle.wheelInfos entry (labels from
// vehicle.wheelLabels), so it works for 4-wheel cars and pod racers.
import { isWheelGrounded } from '../lib/wheelContact.js';
import { classifySurfaceAt } from '../lib/terrainSurface.js';
import { DEFAULT_SURFACE_KEY } from '../lib/surfaceCompounds.js';
import { tyreGrip } from '../lib/tyres.js';

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
  const fuelRow = document.getElementById('susp-fuel');
  const fuelPer100 = document.getElementById('susp-fuel-per100');
  const fuelPerHour = document.getElementById('susp-fuel-perhour');
  const fuelTank = document.getElementById('susp-fuel-tank');
  const tyreRow = document.getElementById('susp-tyres');
  const heatRow = document.getElementById('susp-heat');
  const heatEls = Object.fromEntries(
    ['block', 'coolant', 'oil', 'ambient', 'thermostat', 'fan', 'in', 'rad', 'power', 'level', 'loss', 'leak', 'fix'].map((k) => [k, document.getElementById(`susp-heat-${k}`)])
  );
  const tyreHit = document.getElementById('susp-tyre-hit');
  let heatVehicle = null; // for the debug Leak / Fix buttons
  // Blur so Space (handbrake) doesn't re-click the focused button.
  heatEls.leak?.addEventListener('click', () => {
    heatVehicle?.heat?.startLeak();
    heatEls.leak.blur();
  });
  heatEls.fix?.addEventListener('click', () => {
    heatVehicle?.heat?.repair();
    heatEls.fix.blur();
  });
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
        `<div class="susp-label">${label} <span class="susp-val">&mdash;</span></div>` +
        '<div class="susp-tyre">&mdash;</div>';
      grid.appendChild(wheelEl);
      return {
        terrain: wheelEl.querySelector('.susp-terrain'),
        fill: wheelEl.querySelector('.susp-fill'),
        val: wheelEl.querySelector('.susp-val'),
        tyre: wheelEl.querySelector('.susp-tyre'),
      };
    });
  }

  /**
   * Fill: 0% full droop .. 100% bottomed out, rest marker at 50%; colour
   * as above. Square above each bar: terrain type under that wheel. Below:
   * tread left (title: grip multiplier), or FLAT.
   */
  function updateSuspensionHud(vehicle, debugVisualsEnabled, hasLanded, world, terrainLayers) {
    if (!debugVisualsEnabled || !vehicle) return;

    const signature = `${vehicle.wheelInfos.length}:${vehicle.wheelLabels?.join(',') ?? ''}`;
    if (signature !== lastSignature) {
      rebuildBars(vehicle.wheelInfos, vehicle.wheelLabels);
      lastSignature = signature;
    }

    let hardestHit = null;
    vehicle.wheelInfos.forEach((wheel, i) => {
      const { terrain, fill, val, tyre } = bars[i];
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

      if (wheel.tread !== undefined) {
        tyre.textContent = wheel.punctured ? 'FLAT' : `T ${Math.round(wheel.tread * 100)}%`;
        tyre.classList.toggle('flat', wheel.punctured);
        tyre.title = `Grip x${tyreGrip(wheel).toFixed(2)}`;
        const ratio = wheel.lastStrikeLimit > 0 ? wheel.lastStrikeSpeed / wheel.lastStrikeLimit : 0;
        if (ratio > 0 && (!hardestHit || ratio > hardestHit.ratio)) hardestHit = { ratio, wheel };
      }
    });
    if (tyreRow) tyreRow.hidden = vehicle.wheelInfos[0]?.tread === undefined;
    if (tyreHit) {
      tyreHit.textContent = hardestHit
        ? `${hardestHit.wheel.lastStrikeSpeed.toFixed(1)} / ${hardestHit.wheel.lastStrikeLimit.toFixed(1)}`
        : '—';
    }

    if (landedVal) landedVal.textContent = hasLanded ? 'true' : 'false';
    if (fuelRow) fuelRow.hidden = !vehicle.fuel;
    if (fuelRow && vehicle.fuel) {
      const { litresPerHour, litresPer100Km } = vehicle.fuel.getAverage();
      fuelPer100.textContent = litresPer100Km === null ? '—' : litresPer100Km.toFixed(1);
      fuelPerHour.textContent = litresPerHour.toFixed(1);
      fuelTank.textContent = `${vehicle.fuel.litres.toFixed(1)}/${vehicle.fuel.capacityL}`;
    }
    if (heatRow) heatRow.hidden = !vehicle.heat;
    if (heatRow && vehicle.heat) {
      const heat = vehicle.heat;
      heatEls.block.textContent = heat.blockTempC.toFixed(0);
      heatEls.coolant.textContent = heat.coolantTempC.toFixed(0);
      heatEls.oil.textContent = heat.oilTempC.toFixed(0);
      heatEls.ambient.textContent = heat.ambientC.toFixed(0);
      heatEls.thermostat.textContent = Math.round(heat.thermostat * 100);
      heatEls.fan.textContent = heat.fanOn ? ', fan' : '';
      heatEls.in.textContent = (heat.heatInW / 1000).toFixed(1);
      heatEls.rad.textContent = (heat.radiatorW / 1000).toFixed(1);
      heatEls.power.textContent = Math.round(heat.powerFactor * 100);
      heatEls.level.textContent = `${heat.coolantL.toFixed(1)}/${heat.capacityL.toFixed(1)}`;
      heatEls.loss.textContent = (heat.lossLps * 60).toFixed(2);
      heatVehicle = vehicle;
    }
  }

  return { updateSuspensionHud, el: document.getElementById('suspension-hud') };
}


