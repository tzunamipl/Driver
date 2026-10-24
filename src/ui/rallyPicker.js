// Stage / rally picker: the car to drive (ui/vehiclePicker.js, with the lobby's turning
// model + stats, ui/vehiclePreview.js, its paint, ui/vehicleColorPicker.js, spare wheels, ui/spareTyresPicker.js,
// and for a single stage tyres, ui/tyreSetupPicker.js) and a folding tree of the official scenarios and
// every player's branch (ui/scenarioTree.js); picking a file shows its plan on a map
// (ui/rallyPlanMap.js) with its best times (ui/rallyBestTimes.js), Start (or a double-click) drives it.

import { formatSource } from '../lib/scenarios/source.js';
import { createScenarioTree } from './scenarioTree.js';
import { createVehiclePicker } from './vehiclePicker.js';
import { createVehiclePreview } from './vehiclePreview.js';
import { createRallyPlanMap } from './rallyPlanMap.js';
import { createRallyBestTimes } from './rallyBestTimes.js';
import { createVehicleColorPicker } from './vehicleColorPicker.js';
import { createTyreSetupPicker } from './tyreSetupPicker.js';
import { createSpareTyresPicker } from './spareTyresPicker.js';

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });

/**
 * @param {object} opts
 * @param {string} opts.playerId - finds the player's own row on the online boards.
 * @param {() => void} [opts.onOpen] - e.g. park the car while the picker covers the game.
 * @param {() => void} [opts.onClose]
 */
export function createRallyPicker({ playerId, onOpen, onClose }) {
  const root = document.getElementById('rally-picker');
  // One preview (its own WebGL renderer) for every pick; it only renders while shown.
  const canvas = el('canvas', 'rally-vehicle-preview');
  const stats = el('dl', 'rally-vehicle-stats');
  const preview = createVehiclePreview({ canvas, statsEl: stats });
  const map = createRallyPlanMap();
  const times = createRallyBestTimes({ playerId });
  // Paint edits are stored on Start, dropped on Back.
  const colors = createVehicleColorPicker({ onChange: (color) => preview.setColor(color) });
  const tyres = createTyreSetupPicker({ onChange: (setup) => preview.setTyreSetup(setup) });
  const spares = createSpareTyresPicker();

  function showVehicle(vehicleId) {
    preview.setVehicle(vehicleId);
    colors.show(vehicleId);
    tyres.show(vehicleId);
    spares.show(vehicleId);
  }

  /**
   * Resolves with { plan, vehicleId }, or null on Back.
   * @param {object} opts
   * @param {string} opts.title
   * @param {string} opts.folder - mode folder, e.g. 'rally'.
   * @param {{id: string, label: string, folder: string, indexKey: string}} opts.kind - file kind to list.
   * @param {(picked: {source: string, opened: object, key: string, json: object}) => Promise<object>} opts.loadPlan -
   *   source is 'owner/repo@branch', opened from lib/scenarios/source.js, key from lib/scenarios/paths.js.
   * @param {string} [opts.vehicleId] - preselected car.
   */
  function pick({ title, folder, kind, loadPlan, vehicleId }) {
    // A rally's tyres are picked at its service points.
    const pickTyres = kind.id !== 'rally';
    return new Promise((resolve) => {
      const finish = (result) => {
        if (result) {
          colors.commit();
          spares.commit();
          if (pickTyres) tyres.commit();
        } else {
          colors.discard();
          tyres.discard();
          spares.discard();
        }
        root.hidden = true;
        preview.stop();
        map.stop();
        onClose?.();
        resolve(result);
      };
      let selected = null; // { opened, key, plan (null while loading) }
      let startWhenLoaded = false;
      const start = Object.assign(el('button', '', 'Start'), { type: 'button', disabled: true });
      const startSelected = () => finish({ plan: selected.plan, vehicleId: vehicles.getSelectedId() });
      start.onclick = startSelected;
      map.show(null, `Pick a ${kind.label.toLowerCase()} to see its map`);
      times.show(null);

      function select({ source, opened, key, json }) {
        if (selected?.opened === opened && selected.key === key) return;
        const current = { opened, key, plan: null };
        selected = current;
        startWhenLoaded = false;
        start.disabled = true;
        map.show(null, 'Loading…');
        times.show(null);
        loadPlan({ source: formatSource(source), opened, key, json }).then(
          (plan) => {
            if (selected !== current) return;
            current.plan = plan;
            start.disabled = false;
            map.show(plan);
            times.show(plan);
            if (startWhenLoaded) startSelected();
          },
          (err) => {
            if (selected === current) map.show(null, err.message);
          }
        );
      }

      const tabs = el('div', 'rally-vehicle-tabs');
      const list = el('div', 'rally-vehicle-list');
      const vehicles = createVehiclePicker({ tabsEl: tabs, listEl: list, initialVehicleId: vehicleId, onSelect: showVehicle });
      showVehicle(vehicles.getSelectedId());
      const tree = createScenarioTree({
        folder,
        kinds: [kind],
        onPick: select,
        onActivate(picked) {
          select(picked);
          if (selected.plan) startSelected();
          else startWhenLoaded = true;
        },
      });
      const win = el('div', 'menu-window rally-picker-window');
      const carPick = el('div', 'rally-car-pick');
      carPick.append(tabs, list, colors.el, ...(pickTyres ? [tyres.el] : []), spares.el);
      const showcase = el('div', 'rally-car-showcase');
      showcase.append(canvas, stats);
      const car = el('div', 'rally-car');
      car.append(carPick, showcase);
      win.append(el('h1', 'menu-titlebar', title), el('div', 'rally-picker-heading', 'Car'), car);
      const planPick = el('div', 'rally-plan');
      planPick.append(tree.el, map.el, times.el);
      win.append(el('div', 'rally-picker-heading', `${kind.label}s`), planPick);
      const back = Object.assign(el('button', '', 'Back'), { type: 'button', onclick: () => finish(null) });
      const footer = el('div', 'menu-footer');
      footer.append(start, back);
      win.append(footer);
      root.replaceChildren(win);
      root.hidden = false;
      preview.start();
      map.start();
      onOpen?.();
    });
  }

  return { pick };
}
