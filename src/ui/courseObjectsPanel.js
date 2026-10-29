// Course objects window (left side, scenario editor, formats with `objectTypes`): place-at-car
// buttons, the file's object list, and the selected object's heading dial, tape length, stage versions
// (lib/rally/stageReverse.js; out of the edited one: dimmed) and actions. Built once and patched on change, so typing in a field keeps its focus.

import { attachTips, createHeadingDial, iconButton, patchValue, setTip } from './editorPanel.js';

const hex = (color) => `#${color.toString(16).padStart(6, '0')}`;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const button = (text, onClick, props = {}) => el('button', { type: 'button', textContent: text, onclick: onClick, ...props });

const HEADING_TIP =
  'The way cars come at it (0° = north): a tape runs across it, a sign faces those cars. Placing takes the way the car faces. Drag the dial (Shift: 15° steps) or use the arrow keys.';

/** @param {ReturnType<import('../app/scenarioEditor.js').createScenarioEditor>} editor */
export function createCourseObjectsPanel(editor) {
  const { format, state } = editor;
  const types = format.objectTypes;
  const root = document.getElementById('course-objects-panel');
  root.hidden = false;

  const toggle = button('Objects', null, { className: 'editor-toggle debug-fold-title' });
  const placeEl = el(
    'div',
    { className: 'editor-place' },
    Object.entries(types).map(([type, def]) => {
      const btn = button(def.short, () => editor.placeObject(type));
      setTip(btn, `Place ${def.label}`, `${def.description} Goes exactly where the car is, facing its way. In the editor nothing collides or falls over.`);
      btn.style.setProperty('--editor-swatch', hex(def.color));
      return btn;
    })
  );
  const listEl = el('ol', { className: 'editor-items editor-numbered course-objects-list' });

  const dial = createHeadingDial((degrees) => editor.setObjectField('heading', degrees ?? 0), HEADING_TIP);
  const lengthInput = el('input', { type: 'number', min: 1, max: 200, step: 1 });
  lengthInput.addEventListener('input', () => {
    const value = Number(lengthInput.value);
    if (value > 0) editor.setObjectField('length', value);
  });
  const lengthLabel = el('label', { textContent: 'Length (m)' });
  setTip(lengthLabel, 'Length', 'Tape length across the heading, centred on the object; a stake about every 3 m.');
  const lengthRow = el('div', { className: 'course-objects-length' }, [lengthLabel, lengthInput]);
  const onlySelect = el('select', {}, [
    el('option', { value: '', textContent: 'Both versions' }),
    el('option', { value: 'forward', textContent: 'Forward only' }),
    el('option', { value: 'reverse', textContent: 'Reverse only' }),
  ]);
  onlySelect.addEventListener('change', () => editor.setObjectOnly(onlySelect.value || null));
  const onlyLabel = el('label', { textContent: 'Versions' });
  setTip(onlyLabel, 'Versions', 'Which ways the stage is driven with this object: both (same spot), or only forward / reverse. A sign faces one way: give each version its own.');
  const onlyRow = el('div', { className: 'course-objects-length' }, [onlyLabel, onlySelect]);
  const selectedEl = el('div', { className: 'editor-selected' }, [
    el('label', { textContent: 'Heading' }),
    dial.el,
    lengthRow,
    onlyRow,
    el('div', { className: 'editor-buttons' }, [
      iconButton('moveToCar', 'Move to car', () => editor.moveObjectToCar(), { title: 'Moves it where the car is; the heading stays' }),
      iconButton('goTo', 'Go to', () => editor.goToObject(), { title: 'Teleport to this object' }),
      iconButton('delete', 'Delete', () => editor.deleteObject()),
    ]),
  ]);
  const hintEl = el('p', { className: 'editor-note', textContent: 'Saved with the file: shown for the whole stage, or the whole rally.' });

  root.replaceChildren(toggle, el('div', { className: 'pacenote-body' }, [placeEl, listEl, selectedEl, hintEl]));
  const tips = attachTips(root);

  let shownSelection = null;

  function render() {
    const { objects } = state.doc;
    const isStage = editor.kind().id === 'stage';
    toggle.textContent = objects.length ? `Objects (${objects.length})` : 'Objects';
    listEl.replaceChildren(
      ...objects.map((object, i) => {
        const def = types[object.type];
        const text = `${i + 1}. ${def.label}${def.chain ? ` · ${object.length} m` : ''} · ${Math.round(object.heading)}°${object.only ? ` · ${object.only} only` : ''}`;
        const li = el('li', { textContent: text, onclick: () => editor.selectObject(i) });
        li.classList.toggle('selected', i === state.selectedObject);
        li.classList.toggle('is-other', isStage && object.only === (state.reverse ? 'forward' : 'reverse'));
        li.style.setProperty('--editor-swatch', hex(def.color));
        return li;
      })
    );
    tips.hideIfDetached();
    const object = objects[state.selectedObject];
    selectedEl.hidden = !object;
    if (object) {
      dial.set(object.heading, true);
      lengthRow.hidden = !types[object.type].chain;
      if (types[object.type].chain) patchValue(lengthInput, String(object.length));
      onlyRow.hidden = !isStage;
      onlySelect.value = object.only ?? '';
    }
    if (state.selectedObject !== shownSelection) {
      shownSelection = state.selectedObject;
      listEl.children[state.selectedObject]?.scrollIntoView({ block: 'nearest' });
    }
    for (const btn of root.querySelectorAll('button')) btn.disabled = btn !== toggle && state.busy;
  }

  editor.subscribe(render);
}
