// Tyre widget beside every vehicle picker (lobby, rally picker, debug view, rally tyre service):
// compound + rim / width / profile for the shown car, with the compound's traits. Edits are
// drafts until commit(), which stores them in the active mode's garage (lib/garage.js).

import { getVehicle } from '../lib/vehicles/index.js';
import { getActiveModeId } from '../lib/saves.js';
import { getTyreSetup, setTyreSetup } from '../lib/garage.js';
import { TYRE_COMPOUNDS, TYRE_COMPOUND_IDS, getTyreCompound, compoundGripOn, compoundWearOn } from '../lib/tyres/compounds.js';
import { stockTyreSetup, tyreSizeOptions, sanitizeTyreSetup, sameTyreSetup, tyreSizeLabel } from '../lib/tyres/setup.js';

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });

// Trait rows: grip on surface groups (vs the road tyre), then wet grip.
const GRIP_ROWS = [
  ['Tarmac', ['road']],
  ['Gravel', ['unpaved']],
  ['Dirt', ['normal', 'forest', 'scrub']],
  ['Rock', ['rock']],
  ['Sand', ['sand']],
  ['Ice', ['ice']],
];
// Bar length at this grip multiplier (full width).
const BAR_FULL = 1.6;

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

  const width = select('Width', (v) => edit({ width: Number(v) }));
  const profile = select('Profile', (v) => edit({ profile: Number(v) }));
  const rim = select('Rim', (v) => edit({ rimSize: Number(v) }));
  const sizeRow = el('div', 'tyre-setup-sizes');
  sizeRow.append(width.wrap, profile.wrap, rim.wrap);

  const summary = el('div', 'tyre-setup-summary');
  const sizeText = el('span', 'tyre-setup-size');
  const stockBtn = Object.assign(el('button', 'tyre-setup-stock', 'Stock'), { type: 'button', title: "This vehicle's own tyres" });
  stockBtn.addEventListener('click', () => {
    edit(stockTyreSetup(getVehicle(vehicleId)));
    stockBtn.blur();
  });
  summary.append(sizeText, stockBtn);

  const traits = el('dl', 'tyre-setup-traits');
  root.append(compound.wrap, sizeRow, summary, traits);

  const drafts = new Map(); // vehicle id -> setup
  let vehicleId = null;

  const setup = () => drafts.get(vehicleId) ?? getTyreSetup(vehicleId);

  function edit(patch) {
    drafts.set(vehicleId, sanitizeTyreSetup(getVehicle(vehicleId), { ...setup(), ...patch }));
    render();
    onChange?.(setup());
  }

  function trait(label, value, text) {
    const bar = el('span', 'tyre-setup-bar');
    bar.style.setProperty('--fill', `${Math.round(Math.min(1, value / BAR_FULL) * 100)}%`);
    bar.classList.toggle('good', value > 1.04);
    bar.classList.toggle('poor', value < 0.96);
    const dd = el('dd');
    dd.append(bar, el('span', 'tyre-setup-val', text));
    traits.append(el('dt', '', label), dd);
  }

  function renderTraits(c) {
    traits.replaceChildren();
    for (const [label, keys] of GRIP_ROWS) {
      const grip = keys.reduce((sum, k) => sum + compoundGripOn(c, k), 0) / keys.length;
      trait(label, grip, `${Math.round(grip * 100)}%`);
    }
    trait('Wet', c.wetGrip / getTyreCompound('road').wetGrip, `${Math.round(c.wetGrip * 100)}%`);
    const wear = compoundWearOn(c, 'road');
    trait('Life', 1 / wear, `x${(1 / wear).toFixed(1)}`);
    traits.append(el('dt', '', 'Temp'), el('dd', 'tyre-setup-val', `${c.optimalTempC - c.windowC}–${c.optimalTempC + c.windowC} °C`));
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
    const stock = stockTyreSetup(descriptor);
    const diameterMm = Math.round(s.rimSize * 25.4 + (2 * s.width * s.profile) / 100);
    sizeText.textContent = `${tyreSizeLabel(s)} · ⌀${diameterMm} mm`;
    stockBtn.disabled = sameTyreSetup(s, stock);
    renderTraits(getTyreCompound(s.compound));
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
