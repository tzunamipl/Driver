// Rally refuel zone (points with `refuel: true`, or a click on the fuel bowser): how many
// litres to add, up to a full tank, or Cancel. Picked in litres or gallons (lib/units.js).

import { isImperial, volumeValue, volumeUnit, litresFromVolume } from '../lib/units.js';

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });
const STEP_L = 1;
const STEP_GAL = 0.5;

/**
 * @param {object} [opts]
 * @param {() => void} [opts.onOpen] - e.g. park the car while the dialog covers the game.
 * @param {() => void} [opts.onClose]
 */
export function createRefuelDialog({ onOpen, onClose } = {}) {
  const root = document.getElementById('refuel-dialog');
  let pending = null;

  /** Resolves with the litres to add (> 0), or null on Cancel. */
  function open({ litres, capacityL, fuelType = 'petrol' }) {
    if (pending) return pending;
    pending = new Promise((resolve) => {
      // Slider and box in the shown unit; litres go back out.
      const step = isImperial() ? STEP_GAL : STEP_L;
      const room = Math.max(0, Math.floor(volumeValue(capacityL - litres) / step) * step);
      const finish = (add) => {
        root.hidden = true;
        pending = null;
        onClose?.();
        resolve(add > 0 ? Math.min(capacityL - litres, litresFromVolume(add)) : null);
      };
      const gauge = el('span', 'tyre-setup-bar refuel-gauge');
      const after = el('span', 'tyre-setup-val');
      const slider = Object.assign(el('input', 'refuel-slider'), { type: 'range', min: 0, max: room, step, value: room });
      const amount = Object.assign(el('input', 'refuel-amount'), { type: 'number', min: 0, max: room, step, value: room });
      const add = Object.assign(el('button', '', 'Add fuel'), { type: 'button' });
      const render = (value) => {
        const v = Math.min(room, Math.max(0, Math.round((Number(value) || 0) / step) * step));
        slider.value = String(v);
        amount.value = String(v);
        const total = Math.min(capacityL, litres + litresFromVolume(v));
        // Current fuel dark, the added share lighter.
        gauge.style.setProperty('--fill', `${(litres / capacityL) * 100}%`);
        gauge.style.setProperty('--add', `${(total / capacityL) * 100}%`);
        after.textContent = `${Math.round(volumeValue(total))} / ${Math.round(volumeValue(capacityL))} ${volumeUnit()}`;
        add.disabled = v <= 0;
        return v;
      };
      slider.addEventListener('input', () => render(slider.value));
      amount.addEventListener('input', () => render(amount.value));
      add.onclick = () => finish(render(amount.value));
      const cancel = Object.assign(el('button', '', 'Cancel'), { type: 'button', onclick: () => finish(0) });

      const tank = el('div', 'refuel-row');
      tank.append(el('span', '', 'Tank'), gauge, after);
      const pick = el('div', 'refuel-row');
      const unit = el('label', 'refuel-unit');
      unit.append(amount, el('span', '', volumeUnit()));
      pick.append(el('span', '', 'Add'), slider, unit);
      const footer = el('div', 'menu-footer');
      footer.append(add, cancel);
      const win = el('div', 'menu-window refuel-window');
      const hint = room > 0 ? `${fuelType === 'diesel' ? 'Diesel' : 'Petrol'}: how much to add?` : 'The tank is full.';
      win.append(el('h1', 'menu-titlebar', 'Refuel'), el('p', 'tyre-service-hint', hint), tank, pick, footer);
      root.replaceChildren(win);
      render(room);
      root.hidden = false;
      onOpen?.();
    });
    return pending;
  }

  return { open };
}
