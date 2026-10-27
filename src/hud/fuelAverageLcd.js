import { consumptionValue, consumptionUnit, isImperial } from '../lib/units.js';

// Average fuel consumption LCD beside the outside temperature (cars with descriptor `outsideTempGauge`):
// L/100 km or US mpg over the last WINDOW_S of driving, dashes until the car has covered enough distance.

const WINDOW_S = 600;
const MAX_SHOWN = 99.9; // coasting reads near 0 L/100 km, i.e. near-infinite mpg

/** @param {HTMLElement | null} root - #fuel-average */
export function createFuelAverageLcd(root) {
  if (!root) return { update() {} };
  const value = document.createElement('span');
  const unit = document.createElement('span');
  unit.className = 'fuel-average-unit';
  root.append(value, unit);
  let shown = null;

  /** @param {{ getAverage(windowS: number): { litresPer100Km: number | null } } | null} fuel - null hides it */
  function update(fuel) {
    let text = null;
    if (fuel) {
      const lPer100Km = fuel.getAverage(WINDOW_S).litresPer100Km;
      const v = lPer100Km === null ? null : Math.min(MAX_SHOWN, consumptionValue(Math.max(lPer100Km, 0.01)));
      text = v === null ? '--.-' : v.toFixed(isImperial() && v >= 10 ? 0 : 1);
      text += `|${consumptionUnit()}`;
    }
    if (text === shown) return;
    shown = text;
    root.hidden = text === null;
    if (text === null) return;
    const [v, u] = text.split('|');
    value.textContent = v;
    unit.textContent = u;
  }

  return { update };
}
