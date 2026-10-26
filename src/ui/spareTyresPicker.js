// Rally spare wheels beside the tyre pick (rally picker, tyre service): how many to carry.
// Drafts until commit(), which stores them in the mode's garage (lib/garage.js).

import { getVehicle } from '../lib/vehicles/index.js';
import { getSpareTyres, setSpareTyres } from '../lib/garage.js';
import { MAX_SPARE_TYRES, SPARE_TYRE_KG } from '../lib/spareTyres.js';
import { formatMass } from '../lib/units.js';

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });

export function createSpareTyresPicker() {
  const root = el('label', 'tyre-setup-field spare-tyres-field');
  const input = el('select', 'tyre-setup-select');
  for (let n = 0; n <= MAX_SPARE_TYRES; n++) {
    input.append(Object.assign(document.createElement('option'), { value: String(n), textContent: n ? `${n} · +${formatMass(n * SPARE_TYRE_KG)}` : 'None' }));
  }
  root.append(el('span', '', 'Spare wheels'), input);

  const drafts = new Map(); // vehicle id -> count
  let vehicleId = null;
  const count = () => drafts.get(vehicleId) ?? getSpareTyres(vehicleId);

  input.addEventListener('change', () => {
    drafts.set(vehicleId, Number(input.value));
    input.blur(); // driving keys mustn't keep working the select
  });

  function render() {
    root.hidden = getVehicle(vehicleId).vehicleType === 'hover';
    input.value = String(count());
  }

  return {
    el: root,
    show(id) {
      vehicleId = getVehicle(id).id;
      render();
    },
    /** The shown car's count, drafts included. */
    getCount: count,
    commit() {
      for (const [id, n] of drafts) setSpareTyres(id, n);
      drafts.clear();
    },
    discard() {
      drafts.clear();
      if (vehicleId) render();
    },
  };
}
