// Stage / rally picker, in two steps: the stage / rally from a folding tree of the official scenarios and every
// player's branch (ui/scenarioTree.js; stages listed again in reverse), reopened at the last file picked; picking a file shows its plan
// on a map (ui/rallyPlanMap.js) with its best times (ui/rallyBestTimes.js), and a single stage its time
// of day + weather (ui/stageConditionsPicker.js), and the forecast it would start in (a rally's, or a
// single stage's in Live weather). Next (or a double-click) goes on to the car (the shared ui/carSelect.js,
// with spare wheels and, for a single stage, tyres); Start drives it.

import { formatSource } from '../lib/scenarios/source.js';
import { createScenarioTree } from './scenarioTree.js';
import { createCarSelect } from './carSelect.js';
import { createRallyPlanMap } from './rallyPlanMap.js';
import { createRallyBestTimes } from './rallyBestTimes.js';
import { createStageConditionsPicker } from './stageConditionsPicker.js';
import { forecastTable } from './rallyInfoDialog.js';

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
  const forecastBox = el('div', 'rally-info-scroll rally-picker-forecast');
  let forecastFor = null; // (plan, stageConditions) => Promise<rows | null>
  let forecastPlan = null;
  let forecastToken = 0;
  function showForecast(plan) {
    // Kept up while the same plan's conditions change, so the table doesn't blink.
    if (plan !== forecastPlan || !plan) forecastBox.hidden = true;
    forecastPlan = plan;
    const token = ++forecastToken;
    if (!plan || !forecastFor) return;
    forecastFor(plan, stageConditions.get()).then((rows) => {
      if (token !== forecastToken) return;
      forecastBox.hidden = !rows;
      if (!rows) return;
      forecastBox.replaceChildren(rows.length ? forecastTable(rows) : el('p', 'tyre-service-hint', 'Forecast unavailable'));
    });
  }
  const stageConditions = createStageConditionsPicker({ onChange: () => showForecast(forecastPlan) });

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
   * @param {(plan: object, stageConditions: {timeOfDay: string, weather: string}) => Promise<object[] | null>} [opts.forecast] -
   *   ui/rallyInfoDialog.js forecastTable rows for the picked plan ([] = unavailable), null = none to show.
   */
  function pick({ title, folder, kind, loadPlan, vehicleId, lastFile, onFilePick, forecast }) {
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
        showForecast(null);
        root.hidden = true;
        car.stop();
        map.stop();
        onClose?.();
        sizeLock.disconnect();
        resolve(result);
      };
      let selected = null; // { opened, key, plan (null while loading) }
      let nextWhenLoaded = false;
      const button = (text, onclick) => Object.assign(el('button', '', text), { type: 'button', onclick });
      const next = Object.assign(button('Next', () => showCarStep()), { disabled: true });
      const cancel = button('Back', () => finish(null));
      const toPlan = button('Back', () => showPlanStep());
      const start = button('Start', () => finish({ plan: selected.plan, vehicleId: car.getVehicleId(), ...(pickTyres ? { conditions: stageConditions.get() } : {}) }));
      map.show(null, `Pick a ${kind.label.toLowerCase()} to see its map`);
      times.show(null);
      forecastFor = forecast;
      showForecast(null);

      function select({ source, opened, key, json }) {
        if (selected?.opened === opened && selected.key === key) return;
        const current = { opened, key, plan: null };
        selected = current;
        nextWhenLoaded = false;
        next.disabled = true;
        map.show(null, 'Loading…');
        times.show(null);
        showForecast(null);
        const sourceText = formatSource(source);
        onFilePick?.({ source: sourceText, key });
        loadPlan({ source: sourceText, opened, key, json }).then(
          (plan) => {
            if (selected !== current) return;
            current.plan = plan;
            next.disabled = false;
            map.show(plan);
            times.show(plan);
            showForecast(plan);
            if (nextWhenLoaded) showCarStep();
          },
          (err) => {
            if (selected === current) map.show(null, err.message);
          }
        );
      }

      car.show(vehicleId, { tyres: pickTyres, spares: true });
      const tree = createScenarioTree({
        folder,
        kinds: [kind],
        onPick: select,
        onActivate(picked) {
          select(picked);
          if (selected.plan) showCarStep();
          else nextWhenLoaded = true;
        },
        initialFile: lastFile ? { ...lastFile, kindId: kind.id } : null,
        reverseKinds: ['stage'], // every stage also driven the other way
      });
      const planPick = el('div', 'rally-plan');
      planPick.append(tree.el, map.el, times.el);
      const planStep = [el('div', 'rally-picker-heading', `1 / 2 · ${kind.label}`), planPick, ...(pickTyres ? [stageConditions.el] : []), forecastBox];
      const carStep = [el('div', 'rally-picker-heading', '2 / 2 · Car'), car.el];

      const win = el('div', 'menu-window rally-picker-window');
      const body = el('div', 'rally-picker-body');
      const footer = el('div', 'menu-footer');
      // Grows to the tallest the step has been, so emptied boxes while a file loads don't resize it.
      let lockedHeight = 0;
      const sizeLock = new ResizeObserver(() => {
        const h = win.getBoundingClientRect().height;
        if (h <= lockedHeight) return;
        lockedHeight = h;
        win.style.minHeight = `${h}px`;
      });
      const unlockSize = () => {
        lockedHeight = 0;
        win.style.minHeight = '';
      };
      function showPlanStep() {
        unlockSize();
        car.stop();
        body.replaceChildren(...planStep);
        footer.replaceChildren(next, cancel);
        map.start();
        tree.el.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
      }
      function showCarStep() {
        unlockSize();
        map.stop();
        body.replaceChildren(...carStep);
        footer.replaceChildren(start, toPlan);
        car.start();
      }
      win.append(el('h1', 'menu-titlebar', title), body, footer);
      root.replaceChildren(win);
      root.hidden = false;
      showPlanStep();
      sizeLock.observe(win);
      onOpen?.();
    });
  }

  return { pick };
}
