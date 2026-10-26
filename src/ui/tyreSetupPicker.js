// Tyre widget beside every vehicle picker (lobby, rally picker, debug view, rally tyre service):
// compound + rim / width / profile and the rim style + colour for the shown car. Edits are
// drafts until commit(), which stores them in the active mode's garage (lib/garage.js).

import { getVehicle } from '../lib/vehicles/index.js';
import { getActiveModeId } from '../lib/saves.js';
import { getTyreSetup, setTyreSetup } from '../lib/garage.js';
import { TYRE_COMPOUNDS, TYRE_COMPOUND_IDS } from '../lib/tyres/compounds.js';
import { stockTyreSetup, tyreSizeOptions, sanitizeTyreSetup, sameTyreSetup, sameRims, tyreSizeLabel } from '../lib/tyres/setup.js';
import { AUTO_RIM, RIMS, RIM_IDS, resolveRim, stockRimId } from '../lib/car/rims.js';

const toHex = (n) => `#${n.toString(16).padStart(6, '0')}`;
const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });

function select(label, onChange) {
  const wrap = el('label', 'tyre-setup-field');
  const input = el('select', 'tyre-setup-select');
  input.addEventListener('change', () => {
    onChange(input.value);
    input.blur(); // driving keys mustn't keep working the select
  });
  wrap.append(el('span', '', label), input);
  return { wrap, input };
}

/** Whole wheel diameter (mm): rim plus two sidewalls. */
const diameterMm = ({ rimSize, width, profile }) => rimSize * 25.4 + (2 * width * profile) / 100;

function fillOptions(input, values, format = String) {
  input.replaceChildren(...values.map((v) => Object.assign(document.createElement('option'), { value: String(v), textContent: format(v) })));
}

/**
 * @param {object} [opts]
 * @param {(setup: object) => void} [opts.onChange] - the shown car's setup changed.
 * @param {boolean} [opts.title] - show a "Tyres" heading.
 */
export function createTyreSetupPicker({ onChange, title = true } = {}) {
  const root = el('div', 'tyre-setup');
  if (title) root.append(el('div', 'tyre-setup-title', 'Tyres'));

  const compound = select('Type', (v) => edit({ compound: v }));
  const groups = new Map();
  for (const id of TYRE_COMPOUND_IDS) {
    const c = TYRE_COMPOUNDS[id];
    if (!groups.has(c.group)) groups.set(c.group, Object.assign(document.createElement('optgroup'), { label: c.group }));
    groups.get(c.group).append(Object.assign(document.createElement('option'), { value: id, textContent: c.label }));
  }
  compound.input.append(...groups.values());

  // Rim, then width: each picks the profile that keeps the wheel's diameter closest to stock.
  const rim = select('Rim', (v) => edit(keepDiameter({ rimSize: Number(v) })));
  const width = select('Width', (v) => edit(keepDiameter({ width: Number(v) })));
  const profile = select('Profile', (v) => edit({ profile: Number(v) }));
  const sizeRow = el('div', 'tyre-setup-sizes');
  sizeRow.append(rim.wrap, width.wrap, profile.wrap);

  // Rim look: style (Auto = the car's rim for the compound) + colour (Default = the rim's / car's).
  const rimStyle = select('Wheel', (v) => edit({ rim: v }));
  const rimColor = Object.assign(el('input', 'tyre-setup-rim-color'), { type: 'color', title: 'Rim colour' });
  rimColor.addEventListener('input', () => {
    const n = Number.parseInt(rimColor.value.slice(1), 16);
    if (Number.isInteger(n)) edit({ rimColor: n });
  });
  rimColor.addEventListener('change', () => rimColor.blur());
  const rimColorReset = Object.assign(el('button', 'tyre-setup-rim-reset', 'Default'), { type: 'button', title: "The rim's own colour" });
  rimColorReset.addEventListener('click', () => {
    edit({ rimColor: null });
    rimColorReset.blur();
  });
  const rimRow = el('div', 'tyre-setup-rims');
  rimRow.append(rimStyle.wrap, rimColor, rimColorReset);

  const summary = el('div', 'tyre-setup-summary');
  const sizeText = el('span', 'tyre-setup-size');
  const stockBtn = Object.assign(el('button', 'tyre-setup-stock', 'Stock'), { type: 'button', title: "This vehicle's own tyres" });
  stockBtn.addEventListener('click', () => {
    edit(stockTyreSetup(getVehicle(vehicleId)));
    stockBtn.blur();
  });
  summary.append(sizeText, stockBtn);

  root.append(compound.wrap, sizeRow, rimRow, summary);

  const drafts = new Map(); // vehicle id -> setup
  let vehicleId = null;

  const setup = () => drafts.get(vehicleId) ?? getTyreSetup(vehicleId);

  /** `patch` plus the profile whose wheel diameter is closest to the stock wheel's. */
  function keepDiameter(patch) {
    const descriptor = getVehicle(vehicleId);
    const { rimSize, width } = { ...setup(), ...patch };
    const target = diameterMm(stockTyreSetup(descriptor));
    const best = tyreSizeOptions(descriptor).profile.reduce((a, b) =>
      Math.abs(diameterMm({ rimSize, width, profile: b }) - target) < Math.abs(diameterMm({ rimSize, width, profile: a }) - target) ? b : a
    );
    return { ...patch, profile: best };
  }

  function edit(patch) {
    drafts.set(vehicleId, sanitizeTyreSetup(getVehicle(vehicleId), { ...setup(), ...patch }));
    render();
    onChange?.(setup());
  }

  function render() {
    const descriptor = getVehicle(vehicleId);
    root.hidden = !getActiveModeId() || descriptor.vehicleType === 'hover';
    if (root.hidden) return;
    const s = setup();
    const options = tyreSizeOptions(descriptor);
    fillOptions(width.input, options.width);
    fillOptions(profile.input, options.profile);
    fillOptions(rim.input, options.rim, (v) => `${v}"`);
    compound.input.value = s.compound;
    width.input.value = String(s.width);
    profile.input.value = String(s.profile);
    rim.input.value = String(s.rimSize);
    const auto = Object.assign(document.createElement('option'), { value: AUTO_RIM, textContent: `Auto · ${RIMS[stockRimId(descriptor, s.compound)].label}` });
    rimStyle.input.replaceChildren(auto, ...RIM_IDS.map((id) => Object.assign(document.createElement('option'), { value: id, textContent: RIMS[id].label })));
    rimStyle.input.value = s.rim;
    rimColor.value = toHex(resolveRim({ ...descriptor, tyreCompound: s.compound, tyreSetup: s }).rimColor);
    rimColorReset.disabled = s.rimColor == null;
    const stock = stockTyreSetup(descriptor);
    sizeText.textContent = `${tyreSizeLabel(s)} · ⌀${Math.round(diameterMm(s))} mm`;
    stockBtn.disabled = sameTyreSetup(s, stock) && sameRims(s, stock);
  }

  return {
    el: root,
    /** Shows (and edits) this vehicle's setup; calls onChange with it. */
    show(id) {
      vehicleId = getVehicle(id).id;
      render();
      onChange?.(setup());
    },
    /** The shown car's setup, drafts included. */
    getSetup: setup,
    /** Stores the drafts in the active mode's garage. */
    commit() {
      for (const [id, s] of drafts) setTyreSetup(id, s);
      drafts.clear();
      render();
    },
    /** Drops the drafts. */
    discard() {
      drafts.clear();
      if (vehicleId) render();
    },
  };
}
