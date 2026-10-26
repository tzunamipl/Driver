import { buildDialScale, valueToDeg } from './dialScale.js';
import { getUnits, isImperial, pressureValue, pressureUnit } from '../lib/units.js';

// Small turbo boost gauge tucked behind the tach's upper-left rim (the tach
// covers its lower-right, so the scale sweeps the visible part). Shown only
// for engines with a turbo; vacuum reads below 0.

const MIN_BAR = -1;
const MIN_PSI = -10;
const START_DEG = -150;
const END_DEG = 60;

/** @param {HTMLElement | null} root - #boost-gauge */
export function createBoostGauge(root) {
  if (!root) return { update() {} };
  const ticks = document.createElement('div');
  ticks.className = 'dial-ticks';
  const unit = document.createElement('div');
  unit.className = 'boost-unit';
  unit.textContent = 'bar';
  const needle = document.createElement('div');
  needle.className = 'gauge-needle boost-needle';
  const hub = document.createElement('div');
  hub.className = 'gauge-hub boost-hub';
  root.append(ticks, unit, needle, hub);

  let scale = null;
  let scaleFor = null; // engine.turbo the scale was built for
  let scaleUnits = null;
  let shown = null;

  function update(engine) {
    const turbo = engine?.turbo ?? null;
    root.classList.toggle('visible', !!turbo);
    if (!turbo) return;
    if (turbo !== scaleFor || getUnits() !== scaleUnits) {
      scaleFor = turbo;
      scaleUnits = getUnits();
      // psi: a label every 10 from a -10 floor (so 0 gets one), minor ticks every 5.
      const step = isImperial() ? 10 : 1;
      scale = { min: isImperial() ? MIN_PSI : MIN_BAR, max: Math.ceil(pressureValue(turbo.maxBoostBar) / (step / 2)) * (step / 2), startDeg: START_DEG, endDeg: END_DEG };
      buildDialScale(ticks, { ...scale, step, minorStep: step / 2, label: (v) => String(Math.round(v)), labelRadiusPct: 30 });
      unit.textContent = pressureUnit();
      shown = null;
    }
    const value = Math.round(Math.min(scale.max, Math.max(scale.min, pressureValue(engine.boostBar))) * 100) / 100;
    if (value === shown) return;
    shown = value;
    needle.style.transform = `translate(-50%, -100%) rotate(${valueToDeg(value, scale.max, scale)}deg)`;
  }

  return { update };
}
