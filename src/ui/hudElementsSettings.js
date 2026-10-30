// Settings "Gameplay" HUD table: which dash / HUD parts each game mode shows, remembered in localStorage.
// Applied as `hud-off-<key>` classes on <body> (styles/hud.css) for the active mode; editors show everything.

import { HUD_ELEMENTS_STORAGE_KEY } from '../config.js';
import { GAME_MODES } from '../app/gameModes.js';
import { getActiveModeId, isEditorSession } from '../lib/saves.js';

const ELEMENTS = [
  { key: 'tach', label: 'Rev counter', title: 'Rev counter with the gearbox badges and boost gauge' },
  { key: 'aux', label: 'Temp dials', title: 'Oil pressure, coolant temperature and fuel dial' },
  { key: 'lamps', label: 'Control lamps', title: 'Warning lamps (ABS, TC, handbrake, lights...)' },
  { key: 'minimap', label: 'Minimap' },
  { key: 'all', label: 'Whole HUD', title: 'Off = no HUD at all (menus and dialogs still open)' },
];
const MODES = GAME_MODES.filter((m) => m.available && !m.hidden);

export function createHudElementsSettings() {
  const shown = readShown();
  const table = document.getElementById('hud-elements-table');
  const head = table.createTHead().insertRow();
  head.insertCell().textContent = '';
  for (const mode of MODES) head.insertCell().textContent = mode.label;
  const body = table.createTBody();
  for (const el of ELEMENTS) {
    const row = body.insertRow();
    const name = row.insertCell();
    name.textContent = el.label;
    if (el.title) name.title = el.title;
    for (const mode of MODES) {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = isShown(shown, mode.id, el.key);
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
    const modeId = isEditorSession() ? null : getActiveModeId();
    for (const { key } of ELEMENTS) {
      document.body.classList.toggle(`hud-off-${key}`, !!modeId && !isShown(shown, modeId, key));
    }
  }
  apply();

  return {
    /** Re-applies for the active mode (call once a mode is launched). */
    apply,
  };
}

const isShown = (shown, modeId, key) => shown[modeId]?.[key] ?? true;

function readShown() {
  try {
    const saved = JSON.parse(localStorage.getItem(HUD_ELEMENTS_STORAGE_KEY));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}
