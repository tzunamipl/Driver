import { buildDialScale, valueToDeg } from './dialScale.js';
import { lampIconSvg } from './warningLamps.js';
import { RESERVE_FRACTION } from '../lib/fuel.js';

// Combo gauge between the lamp panel and the tach: oil temp (upper left), coolant
// temp (upper right), both hot at the top, and fuel along the bottom. Each needle
// pivots on its own hub, set out from the dial centre into its sector, and is aimed
// at its value's tick on the centred scale. Missing fields (no engine heat model)
// read as healthy placeholders. The fuel needle reads like a real tank sender: F holds over
// the top of the tank, E is reached with the reserve left, and the needle is damped, so it
// sweeps up after a refuel or a new car (from E, as at ignition) instead of jumping.

const PLACEHOLDER = { oilTempC: 100, coolantTempC: 90, fuelFraction: 1 };
// Tank fraction the fuel needle leaves F at.
const FUEL_FULL_READING = 0.92;
const FUEL_LAG_S = 3;
// Needle moves smaller than this share of the scale aren't redrawn.
const REDRAW_EPS = 0.001;

const SECTORS = [
  {
    key: 'oil', field: 'oilTempC', icon: 'oil', title: 'Oil temperature',
    min: 50, max: 150, startDeg: -100, endDeg: -20, redFrom: 130,
    label: (v, s) => (v === s.min ? 'C' : 'H'),
  },
  {
    key: 'coolant', field: 'coolantTempC', icon: 'coolant', title: 'Coolant temperature',
    min: 50, max: 130, startDeg: 100, endDeg: 20, redFrom: 115,
    label: (v, s) => (v === s.min ? 'C' : 'H'),
  },
  {
    key: 'fuel', field: 'fuelFraction', icon: 'fuel', title: 'Fuel',
    min: 0, max: 1, startDeg: 220, endDeg: 140, redBelow: 0.125,
    label: (v, s) => (v === s.min ? 'E' : 'F'),
    reading: (f) => (f - RESERVE_FRACTION) / (FUEL_FULL_READING - RESERVE_FRACTION),
    lagS: FUEL_LAG_S,
  },
];
const ICON_RADIUS_PCT = 30;
const PIVOT_RADIUS_PCT = 13;
// Radius (% of the dial) the needles aim at: the middle of the tick ring (gauges.css .dial-tick).
const AIM_RADIUS_PCT = 41;

/** Clockwise-from-12 angle a needle pivoting at `pivotRad` (off the dial centre) points at the scale's `deg`. */
function aimDeg(deg, pivotRad) {
  const rad = (deg * Math.PI) / 180;
  const dx = AIM_RADIUS_PCT * Math.sin(rad) - PIVOT_RADIUS_PCT * Math.sin(pivotRad);
  const up = AIM_RADIUS_PCT * Math.cos(rad) - PIVOT_RADIUS_PCT * Math.cos(pivotRad);
  // Unwrapped next to the scale angle, so the needle never spins the long way round.
  const a = (Math.atan2(dx, up) * 180) / Math.PI;
  return a + 360 * Math.round((deg - a) / 360);
}

/** @param {HTMLElement | null} root - #aux-gauge */
export function createAuxGauge(root) {
  if (!root) return { update() {} };
  const needles = SECTORS.map((sector) => {
    const ticks = document.createElement('div');
    ticks.className = 'dial-ticks';
    root.appendChild(ticks);
    buildDialScale(ticks, {
      ...sector,
      step: sector.max - sector.min,
      minorStep: (sector.max - sector.min) / 4,
      label: (v) => sector.label(v, sector),
      labelRadiusPct: 31,
    });

    const rad = (((sector.startDeg + sector.endDeg) / 2) * Math.PI) / 180;
    const pivotLeft = `${50 + PIVOT_RADIUS_PCT * Math.sin(rad)}%`;
    const pivotTop = `${50 - PIVOT_RADIUS_PCT * Math.cos(rad)}%`;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 32 24');
    icon.setAttribute('class', 'aux-icon');
    icon.innerHTML = `<title>${sector.title}</title>${lampIconSvg(sector.icon)}`;
    icon.style.left = `${50 + ICON_RADIUS_PCT * Math.sin(rad)}%`;
    icon.style.top = `${50 - ICON_RADIUS_PCT * Math.cos(rad)}%`;
    root.appendChild(icon);

    const needle = document.createElement('div');
    needle.className = 'gauge-needle aux-needle';
    const hub = document.createElement('div');
    hub.className = 'gauge-hub aux-hub';
    for (const el of [needle, hub]) {
      el.style.left = pivotLeft;
      el.style.top = pivotTop;
    }
    root.append(needle, hub);
    return { sector, needle, pivotRad: rad, value: sector.min, shown: null };
  });
  let lastEngine = null;
  let lastTime = 0;

  /** Hidden without an engine, like the tach. */
  function update(engine) {
    root.classList.toggle('visible', !!engine);
    if (!engine) {
      lastEngine = null;
      return;
    }
    const now = performance.now();
    const dt = engine === lastEngine ? Math.min(0.1, (now - lastTime) / 1000) : 0;
    const fresh = engine !== lastEngine;
    lastEngine = engine;
    lastTime = now;
    for (const item of needles) {
      const { sector } = item;
      const raw = engine[sector.field] ?? PLACEHOLDER[sector.field];
      const target = Math.min(sector.max, Math.max(sector.min, sector.reading ? sector.reading(raw) : raw));
      if (!sector.lagS) item.value = target;
      else if (fresh) item.value = sector.min;
      else item.value += (target - item.value) * (1 - Math.exp(-dt / sector.lagS));
      if (item.shown !== null && Math.abs(item.value - item.shown) < REDRAW_EPS * (sector.max - sector.min)) continue;
      item.shown = item.value;
      const deg = aimDeg(valueToDeg(item.value, sector.max, sector), item.pivotRad);
      item.needle.style.transform = `translate(-50%, -100%) rotate(${deg}deg)`;
    }
  }

  return { update };
}
