// Rally tyre service (points with `tyres: true`): fresh tyres are on, and this offers another
// type or size (ui/tyreSetupPicker.js) before driving on.

import { createTyreSetupPicker } from './tyreSetupPicker.js';

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });

/**
 * @param {object} [opts]
 * @param {() => void} [opts.onOpen] - e.g. park the car while the dialog covers the game.
 * @param {() => void} [opts.onClose]
 */
export function createTyreServiceDialog({ onOpen, onClose } = {}) {
  const root = document.getElementById('tyre-service');
  const tyres = createTyreSetupPicker({ title: false });
  let pending = null;

  /** Resolves with the setup to fit (stored in the mode's garage), or null to keep the current one. */
  function open(vehicleId) {
    if (pending) return pending;
    pending = new Promise((resolve) => {
      const finish = (setup) => {
        if (setup) tyres.commit();
        else tyres.discard();
        root.hidden = true;
        pending = null;
        onClose?.();
        resolve(setup);
      };
      tyres.show(vehicleId);
      const fit = Object.assign(el('button', '', 'Fit'), { type: 'button', onclick: () => finish(tyres.getSetup()) });
      const keep = Object.assign(el('button', '', 'Keep'), { type: 'button', onclick: () => finish(null) });
      const footer = el('div', 'menu-footer');
      footer.append(fit, keep);
      const win = el('div', 'menu-window tyre-service-window');
      win.append(el('h1', 'menu-titlebar', 'Tyre service'), el('p', 'tyre-service-hint', 'Fresh tyres fitted. Change the type or size?'), tyres.el, footer);
      root.replaceChildren(win);
      root.hidden = false;
      onOpen?.();
    });
    return pending;
  }

  return { open };
}
