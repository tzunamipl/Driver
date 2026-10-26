// Garage (free roam + editors, the HUD's Garage button): the shared car step (ui/carSelect.js)
// with paint and tyres. Edits are drafts until Apply.

import { createCarSelect } from './carSelect.js';

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });

/**
 * @param {object} [opts]
 * @param {() => void} [opts.onOpen] - e.g. park the car while the dialog covers the game.
 * @param {() => void} [opts.onClose]
 */
export function createGarageDialog({ onOpen, onClose } = {}) {
  const root = document.getElementById('garage-dialog');
  const car = createCarSelect();
  let pending = null;

  /**
   * Resolves with { vehicleId, color, setup } (stored: paint + tyres in the mode's garage), or null on Cancel.
   * @param {string} vehicleId - the car being driven.
   */
  function open(vehicleId) {
    if (pending) return pending;
    pending = new Promise((resolve) => {
      const finish = (result) => {
        if (result) car.commit();
        else car.discard();
        car.stop();
        root.hidden = true;
        pending = null;
        onClose?.();
        resolve(result);
      };
      car.show(vehicleId, { tyres: true });
      const apply = Object.assign(el('button', '', 'Apply'), {
        type: 'button',
        onclick: () => finish({ vehicleId: car.getVehicleId(), color: car.getColor(), setup: car.getSetup() }),
      });
      const cancel = Object.assign(el('button', '', 'Cancel'), { type: 'button', onclick: () => finish(null) });
      const footer = el('div', 'menu-footer');
      footer.append(apply, cancel);
      const win = el('div', 'menu-window garage-window');
      win.append(el('h1', 'menu-titlebar', 'Garage'), car.el, footer);
      root.replaceChildren(win);
      root.hidden = false;
      car.start();
      onOpen?.();
    });
    return pending;
  }

  return { open };
}
