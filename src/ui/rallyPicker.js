// Stage / rally picker: the car to drive (ui/vehiclePicker.js, with the lobby's turning
// model + stats, ui/vehiclePreview.js) and a folding tree of the official scenarios and
// every player's branch (ui/scenarioTree.js); picking a file starts it.

import { formatSource } from '../lib/scenarios/source.js';
import { createScenarioTree } from './scenarioTree.js';
import { createVehiclePicker } from './vehiclePicker.js';
import { createVehiclePreview } from './vehiclePreview.js';
import { getVehicleColor } from '../lib/vehicleColors.js';

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });

/**
 * @param {object} [hooks]
 * @param {() => void} [hooks.onOpen] - e.g. park the car while the picker covers the game.
 * @param {() => void} [hooks.onClose]
 */
export function createRallyPicker({ onOpen, onClose } = {}) {
  const root = document.getElementById('rally-picker');
  // One preview (its own WebGL renderer) for every pick; it only renders while shown.
  const canvas = el('canvas', 'rally-vehicle-preview');
  const stats = el('dl', 'rally-vehicle-stats');
  const preview = createVehiclePreview({ canvas, statsEl: stats });

  function showVehicle(vehicleId) {
    preview.setVehicle(vehicleId);
    preview.setColor(getVehicleColor(vehicleId));
  }

  /**
   * Resolves with { source ('owner/repo@branch'), opened (lib/scenarios/source.js), json, vehicleId }.
   * @param {object} opts
   * @param {string} opts.title
   * @param {string} opts.folder - mode folder, e.g. 'rally'.
   * @param {{id: string, label: string, folder: string, indexKey: string}} opts.kind - file kind to list.
   * @param {string} [opts.vehicleId] - preselected car.
   */
  function pick({ title, folder, kind, vehicleId }) {
    return new Promise((resolve) => {
      const tabs = el('div', 'rally-vehicle-tabs');
      const list = el('div', 'rally-vehicle-list');
      const vehicles = createVehiclePicker({ tabsEl: tabs, listEl: list, initialVehicleId: vehicleId, onSelect: showVehicle });
      showVehicle(vehicles.getSelectedId());
      const tree = createScenarioTree({
        folder,
        kinds: [kind],
        onPick({ source, opened, json }) {
          root.hidden = true;
          preview.stop();
          onClose?.();
          resolve({ source: formatSource(source), opened, json, vehicleId: vehicles.getSelectedId() });
        },
      });
      const win = el('div', 'menu-window rally-picker-window');
      const carPick = el('div', 'rally-car-pick');
      carPick.append(tabs, list);
      const showcase = el('div', 'rally-car-showcase');
      showcase.append(canvas, stats);
      const car = el('div', 'rally-car');
      car.append(carPick, showcase);
      win.append(el('h1', 'menu-titlebar', title), el('div', 'rally-picker-heading', 'Car'), car);
      win.append(el('div', 'rally-picker-heading', `${kind.label}s`), tree.el);
      root.replaceChildren(win);
      root.hidden = false;
      preview.start();
      onOpen?.();
    });
  }

  return { pick };
}
