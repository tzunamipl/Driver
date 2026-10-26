import { getAirTempC } from '../lib/weather.js';
import { tempValue, tempUnit } from '../lib/units.js';

// Outside temperature LCD in the speedo face, for cars with descriptor `outsideTempGauge`:
// whole degrees (°C or °F) from lib/weather.js, and a snowflake at FROST_WARN_C and below (black ice).

const FROST_WARN_C = 3;

/** @param {HTMLElement | null} root - #outside-temp */
export function createOutsideTempLcd(root) {
  if (!root) return { update() {} };
  const value = document.createElement('span');
  value.className = 'outside-temp-value';
  const frost = document.createElement('span');
  frost.className = 'outside-temp-frost';
  frost.textContent = '❄';
  root.append(frost, value);
  let shown = null;

  /** @param {boolean} fitted - the car has the display */
  function update(fitted) {
    const tempC = getAirTempC();
    const text = fitted ? `${Math.round(tempValue(tempC))}${tempUnit()}` : null;
    if (text === shown) return;
    shown = text;
    root.hidden = text === null;
    if (text === null) return;
    value.textContent = text;
    frost.classList.toggle('lit', Math.round(tempC) <= FROST_WARN_C);
  }

  return { update };
}
