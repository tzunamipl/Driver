// Garage (free roam + editors, the HUD's Garage button): the car to drive (ui/vehiclePicker.js) with
// its paint (ui/vehicleColorPicker.js) and tyres (ui/tyreSetupPicker.js) beside the turning model and
// stats (ui/vehiclePreview.js). Edits are drafts until Apply.

import { createVehiclePicker } from './vehiclePicker.js';
import { createVehiclePreview } from './vehiclePreview.js';
import { createVehicleColorPicker } from './vehicleColorPicker.js';
import { createTyreSetupPicker } from './tyreSetupPicker.js';

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });

/**
 * @param {object} [opts]
 * @param {() => void} [opts.onOpen] - e.g. park the car while the dialog covers the game.
 * @param {() => void} [opts.onClose]
 */
export function createGarageDialog({ onOpen, onClose } = {}) {
  const root = document.getElementById('garage-dialog');
  const canvas = el('canvas', 'rally-vehicle-preview');
  const stats = el('dl', 'rally-vehicle-stats');
  const preview = createVehiclePreview({ canvas, statsEl: stats });
  const colors = createVehicleColorPicker({ onChange: (color) => preview.setColor(color) });
  const tyres = createTyreSetupPicker({ onChange: (setup) => preview.setTyreSetup(setup) });
  let pending = null;

  function showVehicle(vehicleId) {
    preview.setVehicle(vehicleId);
    colors.show(vehicleId);
    tyres.show(vehicleId);
  }

  /**
   * Resolves with { vehicleId, color, setup } (stored: paint + tyres in the mode's garage), or null on Cancel.
   * @param {string} vehicleId - the car being driven.
   */
  function open(vehicleId) {
    if (pending) return pending;
    pending = new Promise((resolve) => {
      const finish = (result) => {
        if (result) {
          colors.commit();
          tyres.commit();
        } else {
          colors.discard();
          tyres.discard();
        }
        preview.stop();
        root.hidden = true;
        pending = null;
        onClose?.();
        resolve(result);
      };
      const tabs = el('div', 'rally-vehicle-tabs');
      const list = el('div', 'rally-vehicle-list');
      const vehicles = createVehiclePicker({ tabsEl: tabs, listEl: list, initialVehicleId: vehicleId, onSelect: showVehicle });
      showVehicle(vehicles.getSelectedId());
      const carPick = el('div', 'rally-car-pick');
      carPick.append(tabs, list, colors.el, tyres.el);
      const showcase = el('div', 'rally-car-showcase');
      showcase.append(canvas, stats);
      const car = el('div', 'rally-car');
      car.append(carPick, showcase);
      const apply = Object.assign(el('button', '', 'Apply'), {
        type: 'button',
        onclick: () => finish({ vehicleId: vehicles.getSelectedId(), color: colors.getColor(), setup: tyres.getSetup() }),
      });
      const cancel = Object.assign(el('button', '', 'Cancel'), { type: 'button', onclick: () => finish(null) });
      const footer = el('div', 'menu-footer');
      footer.append(apply, cancel);
      const win = el('div', 'menu-window garage-window');
      win.append(el('h1', 'menu-titlebar', 'Garage'), car, footer);
      root.replaceChildren(win);
      root.hidden = false;
      preview.start();
      onOpen?.();
    });
    return pending;
  }

  return { open };
}
