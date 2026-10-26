// Single stage conditions beside the car pick (rally picker): time of day and weather.
// Drafts until commit(), which keeps them in the save slot for the next pick.

import { readSaveField, writeSaveField } from '../lib/saves.js';
import { STAGE_TIMES, STAGE_WEATHER, DEFAULT_STAGE_CONDITIONS } from '../app/rally/rallyConditions.js';

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });

function select(label, options, onChange) {
  const root = el('label', 'tyre-setup-field');
  const input = el('select', 'tyre-setup-select');
  for (const { id, label: text } of options) input.append(Object.assign(document.createElement('option'), { value: id, textContent: text }));
  input.addEventListener('change', () => {
    onChange(input.value);
    input.blur(); // driving keys mustn't keep working the select
  });
  root.append(el('span', '', label), input);
  return { root, input };
}

export function createStageConditionsPicker() {
  let draft = null;
  const saved = () => ({ ...DEFAULT_STAGE_CONDITIONS, ...readSaveField('stageConditions') });
  const current = () => draft ?? saved();
  const time = select('Time of day', STAGE_TIMES, (id) => (draft = { ...current(), timeOfDay: id }));
  const weather = select('Weather', STAGE_WEATHER, (id) => (draft = { ...current(), weather: id }));
  const root = el('div', 'stage-conditions');
  root.append(time.root, weather.root);

  function render() {
    const { timeOfDay, weather: sky } = current();
    time.input.value = timeOfDay;
    weather.input.value = sky;
  }
  render();

  return {
    el: root,
    /** { timeOfDay, weather } (rallyConditions.js ids), drafts included. */
    get: current,
    commit() {
      if (draft) writeSaveField('stageConditions', draft);
      draft = null;
    },
    discard() {
      draft = null;
      render();
    },
  };
}
