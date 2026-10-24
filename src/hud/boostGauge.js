import { buildDialScale, valueToDeg } from './dialScale.js';

// Small turbo boost gauge tucked behind the tach's upper-left rim (the tach
// covers its lower-right, so the scale sweeps the visible part). Shown only
// for engines with a turbo; vacuum reads below 0.

const MIN_BAR = -1;
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
  let shown = null;

  function update(engine) {
    const turbo = engine?.turbo ?? null;
    root.classList.toggle('visible', !!turbo);
    if (!turbo) return;
    if (turbo !== scaleFor) {
      scaleFor = turbo;
      scale = { min: MIN_BAR, max: Math.ceil(turbo.maxBoostBar * 2) / 2, startDeg: START_DEG, endDeg: END_DEG };
      buildDialScale(ticks, { ...scale, step: 1, minorStep: 0.5, label: String, labelRadiusPct: 30 });
      shown = null;
    }
    const value = Math.round(Math.min(scale.max, Math.max(MIN_BAR, engine.boostBar)) * 100) / 100;
    if (value === shown) return;
    shown = value;
    needle.style.transform = `translate(-50%, -100%) rotate(${valueToDeg(value, scale.max, scale)}deg)`;
  }

  return { update };
}
