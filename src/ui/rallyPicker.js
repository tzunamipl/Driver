// Stage / rally picker, in two steps: the car (the shared ui/carSelect.js, with spare wheels and, for a
// single stage, tyres), then the stage / rally from a folding tree of the official scenarios and every
// player's branch (ui/scenarioTree.js), reopened at the last file picked; picking a file shows its plan
// on a map (ui/rallyPlanMap.js) with its best times (ui/rallyBestTimes.js), and a single stage its time
// of day + weather (ui/stageConditionsPicker.js). Start (or a double-click) drives it.

import { formatSource } from '../lib/scenarios/source.js';
import { createScenarioTree } from './scenarioTree.js';
import { createCarSelect } from './carSelect.js';
import { createRallyPlanMap } from './rallyPlanMap.js';
import { createRallyBestTimes } from './rallyBestTimes.js';
import { createStageConditionsPicker } from './stageConditionsPicker.js';

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });

/**
 * @param {object} opts
 * @param {string} opts.playerId - finds the player's own row on the online boards.
 * @param {() => void} [opts.onOpen] - e.g. park the car while the picker covers the game.
 * @param {() => void} [opts.onClose]
 */
export function createRallyPicker({ playerId, onOpen, onClose }) {
  const root = document.getElementById('rally-picker');
  const car = createCarSelect();
  const map = createRallyPlanMap();
  const times = createRallyBestTimes({ playerId });
  const stageConditions = createStageConditionsPicker();

  /**
   * Resolves with { plan, vehicleId, conditions (a single stage's { timeOfDay, weather }) }, or null on Back.
   * @param {object} opts
   * @param {string} opts.title
   * @param {string} opts.folder - mode folder, e.g. 'rally'.
   * @param {{id: string, label: string, folder: string, indexKey: string}} opts.kind - file kind to list.
   * @param {(picked: {source: string, opened: object, key: string, json: object}) => Promise<object>} opts.loadPlan -
   *   source is 'owner/repo@branch', opened from lib/scenarios/source.js, key from lib/scenarios/paths.js.
   * @param {string} [opts.vehicleId] - preselected car.
   * @param {{source: string, key: string} | null} [opts.lastFile] - file to reopen the tree at.
   * @param {(file: {source: string, key: string}) => void} [opts.onFilePick] - a file was picked in the tree.
   */
  function pick({ title, folder, kind, loadPlan, vehicleId, lastFile, onFilePick }) {
    // A rally's tyres are picked at its service points.
    const pickTyres = kind.id !== 'rally';
    return new Promise((resolve) => {
      const finish = (result) => {
        if (result) {
          car.commit();
          if (pickTyres) stageConditions.commit();
        } else {
          car.discard();
          stageConditions.discard();
        }
        root.hidden = true;
        car.stop();
        map.stop();
        onClose?.();
        resolve(result);
      };
      let selected = null; // { opened, key, plan (null while loading) }
      let startWhenLoaded = false;
      const start = Object.assign(el('button', '', 'Start'), { type: 'button', disabled: true });
      const startSelected = () => finish({ plan: selected.plan, vehicleId: car.getVehicleId(), ...(pickTyres ? { conditions: stageConditions.get() } : {}) });
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
        const sourceText = formatSource(source);
        onFilePick?.({ source: sourceText, key });
        loadPlan({ source: sourceText, opened, key, json }).then(
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

      car.show(vehicleId, { tyres: pickTyres, spares: true });
      // Built with the car step, so the tree (and the remembered file) loads while the car is picked.
      const tree = createScenarioTree({
        folder,
        kinds: [kind],
        onPick: select,
        onActivate(picked) {
          select(picked);
          if (selected.plan) startSelected();
          else startWhenLoaded = true;
        },
        initialFile: lastFile ? { ...lastFile, kindId: kind.id } : null,
      });
      const planPick = el('div', 'rally-plan');
      planPick.append(tree.el, map.el, times.el);
      const planStep = [el('div', 'rally-picker-heading', `2 / 2 · ${kind.label}`), planPick, ...(pickTyres ? [stageConditions.el] : [])];
      const carStep = [el('div', 'rally-picker-heading', '1 / 2 · Car'), car.el];

      const win = el('div', 'menu-window rally-picker-window');
      const body = el('div', 'rally-picker-body');
      const footer = el('div', 'menu-footer');
      const button = (text, onclick) => Object.assign(el('button', '', text), { type: 'button', onclick });
      const next = button('Next', () => showPlanStep());
      const cancel = button('Back', () => finish(null));
      const toCar = button('Back', () => showCarStep());
      function showCarStep() {
        map.stop();
        body.replaceChildren(...carStep);
        footer.replaceChildren(next, cancel);
        car.start();
      }
      function showPlanStep() {
        car.stop();
        body.replaceChildren(...planStep);
        footer.replaceChildren(start, toCar);
        map.start();
        tree.el.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
      }
      win.append(el('h1', 'menu-titlebar', title), body, footer);
      root.replaceChildren(win);
      root.hidden = false;
      showCarStep();
      onOpen?.();
    });
  }

  return { pick };
}
