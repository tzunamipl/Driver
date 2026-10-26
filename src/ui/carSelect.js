// Car selection step shared by every mode's car pick (rally picker, Garage): the car to drive
// (ui/vehiclePicker.js) with its paint (ui/vehicleColorPicker.js), optionally its tyres
// (ui/tyreSetupPicker.js) and spare wheels (ui/spareTyresPicker.js), beside the turning model and
// stats (ui/vehiclePreview.js). Edits are drafts until commit(), stored in the mode's garage (lib/garage.js).

import { createVehiclePicker } from './vehiclePicker.js';
import { createVehiclePreview } from './vehiclePreview.js';
import { createVehicleColorPicker } from './vehicleColorPicker.js';
import { createTyreSetupPicker } from './tyreSetupPicker.js';
import { createSpareTyresPicker } from './spareTyresPicker.js';

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });

export function createCarSelect() {
  // One preview (its own WebGL renderer) for every show; it only renders between start() and stop().
  const canvas = el('canvas', 'rally-vehicle-preview');
  const stats = el('dl', 'rally-vehicle-stats');
  const preview = createVehiclePreview({ canvas, statsEl: stats });
  const colors = createVehicleColorPicker({ onChange: (color) => preview.setColor(color) });
  const tyres = createTyreSetupPicker({ onChange: (setup) => preview.setTyreSetup(setup) });
  const spares = createSpareTyresPicker();
  const root = el('div', 'rally-car');
  let vehicles = null;
  let fields = { tyres: false, spares: false };

  function showVehicle(vehicleId) {
    preview.setVehicle(vehicleId);
    colors.show(vehicleId);
    if (fields.tyres) tyres.show(vehicleId);
    if (fields.spares) spares.show(vehicleId);
  }

  /**
   * Fills the step for a new pick.
   * @param {string} [vehicleId] - preselected car.
   * @param {{tyres?: boolean, spares?: boolean}} [opts] - which setup fields to offer.
   */
  function show(vehicleId, { tyres: withTyres = true, spares: withSpares = false } = {}) {
    fields = { tyres: withTyres, spares: withSpares };
    const tabs = el('div', 'rally-vehicle-tabs');
    const list = el('div', 'rally-vehicle-list');
    vehicles = createVehiclePicker({ tabsEl: tabs, listEl: list, initialVehicleId: vehicleId, onSelect: showVehicle });
    const carPick = el('div', 'rally-car-pick');
    carPick.append(tabs, list, colors.el, ...(withTyres ? [tyres.el] : []), ...(withSpares ? [spares.el] : []));
    const showcase = el('div', 'rally-car-showcase');
    showcase.append(canvas, stats);
    root.replaceChildren(carPick, showcase);
    showVehicle(vehicles.getSelectedId());
  }

  return {
    el: root,
    show,
    start: () => preview.start(),
    stop: () => preview.stop(),
    getVehicleId: () => vehicles.getSelectedId(),
    getColor: () => colors.getColor(),
    getSetup: () => tyres.getSetup(),
    commit() {
      colors.commit();
      if (fields.tyres) tyres.commit();
      if (fields.spares) spares.commit();
    },
    discard() {
      colors.discard();
      tyres.discard();
      spares.discard();
    },
  };
}
