// Rally tyre service (points with `tyres: true`: fresh tyres are on; or a click on the tyre props:
// nothing fitted yet). Shows the set taken off (or still on) corner by corner, and offers another
// type or size (ui/tyreSetupPicker.js) with a turning 3D wheel of the pick (ui/tyrePreview.js).

import { createTyreSetupPicker } from './tyreSetupPicker.js';
import { createTyrePreview } from './tyrePreview.js';
import { getTyreCompound } from '../lib/tyres/compounds.js';
import { tyreSizeLabel } from '../lib/tyres/setup.js';

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });
// Tread below this reads as bald, below the second as worn.
const BALD_TREAD = 0.05;
const WORN_TREAD = 0.35;
// Dirt / wetness shown from this much.
const SHOW_DIRT = 0.05;
const SHOW_WET = 0.15;

/** One corner of the removed set: tread bar, temperature against the compound's window, dirt, water, verdict. */
function wheelCard(label, w, compound) {
  const card = el('div', 'tyre-service-wheel');
  const verdict = w.punctured ? ['Flat', 'bad'] : w.tread < BALD_TREAD ? ['Bald', 'bad'] : w.tread < WORN_TREAD ? ['Worn', 'warn'] : ['OK', 'good'];
  const head = el('div', 'tyre-service-wheel-head');
  head.append(el('b', '', label), el('span', `tyre-service-verdict ${verdict[1]}`, verdict[0]));
  const bar = el('span', 'tyre-setup-bar');
  bar.style.setProperty('--fill', `${Math.round(w.tread * 100)}%`);
  bar.classList.toggle('good', w.tread >= WORN_TREAD);
  bar.classList.toggle('poor', w.tread < WORN_TREAD);
  const tread = el('div', 'tyre-service-row');
  tread.append(el('span', '', 'Tread'), bar, el('span', 'tyre-setup-val', `${Math.round(w.tread * 100)}%`));
  const lo = compound.optimalTempC - compound.windowC;
  const hi = compound.optimalTempC + compound.windowC;
  const tempC = Number.isFinite(w.tempC) ? Math.round(w.tempC) : null;
  const temp = el('div', 'tyre-service-row');
  const tempClass = tempC == null ? '' : tempC < lo ? 'cold' : tempC > hi ? 'hot' : 'good';
  temp.append(el('span', '', 'Temp'), el('span', `tyre-service-temp ${tempClass}`, tempC == null ? '–' : `${tempC} °C`));
  const notes = [];
  if (w.dirt >= SHOW_DIRT) notes.push(`dirt ${Math.round(w.dirt * 100)}%`);
  if (w.wetness >= SHOW_WET) notes.push(`wet ${Math.round(w.wetness * 100)}%`);
  card.append(head, tread, temp, el('div', 'tyre-service-notes', notes.join(' · ') || 'clean'));
  return card;
}

/**
 * The set's cards, two per axle (wheelLabels order: left, right), under a 3D view of its dirtiest tyre.
 * @param {{ preview: object, canvas: HTMLCanvasElement }} used - tyrePreview.js for that tyre.
 */
function removedPanel(vehicleId, removed, title, used) {
  const panel = el('div', 'tyre-service-removed');
  const compound = getTyreCompound(removed.setup?.compound);
  const avg = removed.wheels.reduce((sum, w) => sum + w.tread, 0) / removed.wheels.length;
  panel.append(
    el('div', 'tyre-setup-title', title),
    el('div', 'tyre-service-sub', `${compound.label}${removed.setup ? ` · ${tyreSizeLabel(removed.setup)}` : ''} · avg tread ${Math.round(avg * 100)}%`)
  );
  if (removed.setup) {
    const dirtiest = removed.wheels.reduce((best, w, i) => (w.dirt > removed.wheels[best].dirt ? i : best), 0);
    const w = removed.wheels[dirtiest];
    used.preview.show(vehicleId, removed.setup, { tread: w.tread, dirt: w.dirt ?? 0 });
    const label = removed.labels?.[dirtiest] ?? String(dirtiest);
    panel.append(used.canvas, el('div', 'tyre-service-caption', `${label} · ${w.dirt >= SHOW_DIRT ? 'dirtiest' : 'clean'} · tread ${Math.round(w.tread * 100)}%`));
  }
  const grid = el('div', 'tyre-service-wheels');
  removed.wheels.forEach((w, i) => grid.append(wheelCard(removed.labels?.[i] ?? String(i), w, compound)));
  panel.append(grid);
  return panel;
}

/**
 * @param {object} [opts]
 * @param {() => void} [opts.onOpen] - e.g. park the car while the dialog covers the game.
 * @param {() => void} [opts.onClose]
 */
export function createTyreServiceDialog({ onOpen, onClose } = {}) {
  const root = document.getElementById('tyre-service');
  const canvas = el('canvas', 'tyre-service-preview');
  const preview = createTyrePreview(canvas);
  const usedCanvas = el('canvas', 'tyre-service-preview');
  const used = { canvas: usedCanvas, preview: createTyrePreview(usedCanvas) };
  let shownVehicleId = null;
  const tyres = createTyreSetupPicker({ title: false, onChange: (setup) => shownVehicleId && preview.show(shownVehicleId, setup) });
  let pending = null;

  /**
   * Resolves with the setup to fit (stored in the mode's garage), or null to keep the current one.
   * @param {string} vehicleId
   * @param {{ setup: object, labels: string[], wheels: object[] } | null} [removed] - the set taken off, or on (getTyreState()).
   * @param {{ fitted?: boolean }} [opts] - fitted false: nothing fitted yet, Fit puts on a fresh set.
   */
  function open(vehicleId, removed = null, { fitted = true } = {}) {
    if (pending) return pending;
    pending = new Promise((resolve) => {
      const finish = (setup) => {
        if (setup) tyres.commit();
        else tyres.discard();
        preview.stop();
        used.preview.stop();
        root.hidden = true;
        pending = null;
        onClose?.();
        resolve(setup);
      };
      shownVehicleId = vehicleId;
      tyres.show(vehicleId);
      const fit = Object.assign(el('button', '', 'Fit'), { type: 'button', onclick: () => finish(tyres.getSetup()) });
      const keep = Object.assign(el('button', '', fitted ? 'Keep' : 'Cancel'), { type: 'button', onclick: () => finish(null) });
      const footer = el('div', 'menu-footer');
      footer.append(fit, keep);
      const choice = el('div', 'tyre-service-choice');
      choice.append(el('div', 'tyre-setup-title', 'Fit'), canvas, tyres.el);
      const body = el('div', 'tyre-service-body-grid');
      if (removed?.wheels?.length) body.append(removedPanel(vehicleId, removed, fitted ? 'Removed tyres' : 'Current tyres', used));
      body.append(choice);
      const win = el('div', 'menu-window tyre-service-window');
      win.append(el('h1', 'menu-titlebar', 'Tyre service'), el('p', 'tyre-service-hint', fitted ? 'Fresh tyres fitted. Change the type or size?' : 'Fit a fresh set? Pick the type and size.'), body, footer);
      root.replaceChildren(win);
      root.hidden = false;
      preview.start();
      if (removed?.wheels?.length && removed.setup) used.preview.start();
      onOpen?.();
    });
    return pending;
  }

  return { open };
}
