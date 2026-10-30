// Settings "Gameplay" HUD table: which dash / HUD parts each game mode shows, remembered in localStorage.
// Applied as `hud-off-<key>` classes on <body> (styles/hud.css) for the active mode; editors show everything.
// Rally has two columns: while the stage clock runs (`rallyStage`) and everywhere else (`rally`).
// `onlyIn`: modes the part exists in; `neverIn`: modes it's always hidden in (no checkbox);
// `stageDefault`: unsaved value in the on-stage column.

import { HUD_ELEMENTS_STORAGE_KEY } from '../config.js';
import { GAME_MODES } from '../app/gameModes.js';
import { getActiveModeId, isEditorSession } from '../lib/saves.js';

const ELEMENTS = [
  { key: 'tach', label: 'Rev counter', title: 'Rev counter with the gearbox badges and boost gauge' },
  { key: 'aux', label: 'Temp dials', title: 'Oil pressure, coolant temperature and fuel dial' },
  { key: 'lamps', label: 'Control lamps', title: 'Warning lamps (ABS, TC, handbrake, lights...)' },
  { key: 'minimap', label: 'Minimap', stageDefault: false },
  { key: 'garage', label: 'Garage button', neverIn: ['rally'] },
  { key: 'players', label: 'Player list', stageDefault: false },
  { key: 'navigation', label: 'Navigation', stageDefault: false },
  { key: 'itinerary', label: 'Itinerary', onlyIn: ['rally'], stageDefault: false },
  { key: 'all', label: 'Whole HUD', title: 'Off = no HUD at all (menus and dialogs still open)' },
];
const RALLY_STAGE = 'rallyStage';
const COLUMNS = GAME_MODES.filter((m) => m.available && !m.hidden).flatMap((m) =>
  m.id === 'rally'
    ? [{ id: RALLY_STAGE, mode: 'rally', label: 'Rally on stage' }, { id: 'rally', mode: 'rally', label: 'Rally off stage' }]
    : [{ id: m.id, mode: m.id, label: m.label }],
);

export function createHudElementsSettings() {
  const shown = readShown();
  let onRallyStage = false;
  const table = document.getElementById('hud-elements-table');
  const head = table.createTHead().insertRow();
  head.insertCell().textContent = '';
  for (const mode of COLUMNS) head.insertCell().textContent = mode.label;
  const body = table.createTBody();
  for (const el of ELEMENTS) {
    const row = body.insertRow();
    const name = row.insertCell();
    name.textContent = el.label;
    if (el.title) name.title = el.title;
    for (const mode of COLUMNS) {
      if (!hasCheckbox(el, mode.mode)) {
        row.insertCell();
        continue;
      }
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = isShown(shown, mode.id, el);
      input.setAttribute('aria-label', `${el.label} in ${mode.label}`);
      input.addEventListener('change', () => {
        (shown[mode.id] ??= {})[el.key] = input.checked;
        try { localStorage.setItem(HUD_ELEMENTS_STORAGE_KEY, JSON.stringify(shown)); } catch { /* private mode */ }
        input.blur(); // Space is the handbrake, not a checkbox toggle
        apply();
      });
      row.insertCell().appendChild(input);
    }
  }

  function apply() {
    const activeId = isEditorSession() ? null : getActiveModeId();
    const modeId = activeId === 'rally' && onRallyStage ? RALLY_STAGE : activeId;
    for (const el of ELEMENTS) {
      const off = !!activeId && (el.neverIn?.includes(activeId) || !isShown(shown, modeId, el));
      document.body.classList.toggle(`hud-off-${el.key}`, off);
    }
  }
  apply();

  return {
    /** Re-applies for the active mode (call once a mode is launched). */
    apply,
    /** Rally: switches between the on-stage and off-stage columns. */
    setRallyStage(on) {
      if (on === onRallyStage) return;
      onRallyStage = on;
      apply();
    },
  };
}

const isShown = (shown, columnId, el) => shown[columnId]?.[el.key] ?? (columnId === RALLY_STAGE ? el.stageDefault ?? true : true);
const hasCheckbox = (el, modeId) => (!el.onlyIn || el.onlyIn.includes(modeId)) && !el.neverIn?.includes(modeId);

function readShown() {
  try {
    const saved = JSON.parse(localStorage.getItem(HUD_ELEMENTS_STORAGE_KEY));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}
