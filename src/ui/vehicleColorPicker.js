// Paint widget beside every vehicle picker (lobby, stage / rally picker, debug view): the shown
// car's colour + Metallic + Default, and its "default paint" toggle (kept per car). Edits are drafts
// until commit(), so a cancelled picker leaves the stored paint alone.

import { DEFAULT_BODY_COLOR } from '../config.js';
import { isMetallicPaint, paintRgb, withMetallic } from '../lib/vehicles/geometry/paint.js';
import { defaultVehicleColor, getCustomVehicleColor, setVehicleColor, usesDefaultPaint, setUseDefaultPaint } from '../lib/vehicleColors.js';

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });
const toHex = (n) => `#${n.toString(16).padStart(6, '0')}`;

/**
 * @param {object} [opts]
 * @param {(color: number) => void} [opts.onChange] - the shown car's resulting paint changed.
 */
export function createVehicleColorPicker({ onChange } = {}) {
  const root = el('div', 'vehicle-color');
  const row = el('div', 'vehicle-color-row');
  const input = Object.assign(el('input', 'vehicle-color-input'), { type: 'color', value: '#ffffff' });
  input.setAttribute('aria-label', 'Car colour');
  const metallicLabel = el('label', 'vehicle-color-metallic');
  const metallic = Object.assign(document.createElement('input'), { type: 'checkbox' });
  metallicLabel.append(metallic, ' Metallic');
  const reset = Object.assign(el('button', 'vehicle-color-reset', 'Default'), { type: 'button', title: "Restore this vehicle's default colour" });
  row.append(input, metallicLabel, reset);
  const toggleLabel = el('label', 'vehicle-color-toggle');
  const toggle = Object.assign(document.createElement('input'), { type: 'checkbox' });
  toggleLabel.append(toggle, ' Use default paint');
  root.append(row, toggleLabel);

  const drafts = new Map(); // vehicle id -> colour
  const draftDefaultPaint = new Map(); // vehicle id -> toggle
  let vehicleId = null;

  const defaultPaint = () => draftDefaultPaint.get(vehicleId) ?? usesDefaultPaint(vehicleId);
  const customColor = (id) => drafts.get(id) ?? getCustomVehicleColor(id);
  const color = () => (defaultPaint() ? defaultVehicleColor(vehicleId) : customColor(vehicleId));

  function render() {
    if (!vehicleId) return;
    const on = defaultPaint();
    toggle.checked = on;
    input.value = toHex(paintRgb(color()));
    input.disabled = on;
    metallic.checked = isMetallicPaint(color());
    metallic.disabled = on;
    reset.disabled = on || customColor(vehicleId) === defaultVehicleColor(vehicleId);
  }

  function changed() {
    render();
    onChange?.(color());
  }

  input.addEventListener('input', () => {
    const n = Number.parseInt(input.value.replace('#', ''), 16);
    const rgb = Number.isInteger(n) && n >= 0 && n <= 0xffffff ? n : DEFAULT_BODY_COLOR;
    drafts.set(vehicleId, withMetallic(rgb, metallic.checked));
    changed();
  });
  metallic.addEventListener('change', () => {
    drafts.set(vehicleId, withMetallic(customColor(vehicleId), metallic.checked));
    changed();
  });
  reset.addEventListener('click', () => {
    drafts.set(vehicleId, defaultVehicleColor(vehicleId));
    changed();
  });
  toggle.addEventListener('change', () => {
    draftDefaultPaint.set(vehicleId, toggle.checked);
    changed();
  });

  return {
    el: root,
    /** Shows (and edits) this vehicle's paint; calls onChange with it. */
    show(id) {
      vehicleId = id;
      changed();
    },
    /** The shown car's paint, drafts included. */
    getColor: color,
    /** Stores the drafts. */
    commit() {
      for (const [id, c] of drafts) setVehicleColor(id, c);
      for (const [id, on] of draftDefaultPaint) setUseDefaultPaint(id, on);
      drafts.clear();
      draftDefaultPaint.clear();
      render();
    },
    /** Drops the drafts. */
    discard() {
      drafts.clear();
      draftDefaultPaint.clear();
      render();
    },
  };
}
