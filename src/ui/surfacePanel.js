// Surfaces window (left side, scenario editor, stages only): mark a section of the stage road at the
// car (start, then end) with its surface, the list of sections, and the selected one's surface and
// actions. Patched on every editor change.

import { STAGE_SURFACES, STAGE_SURFACE_IDS } from '../lib/rally/stageSurfaces.js';
import { longDistanceValue, longDistanceUnit } from '../lib/units.js';
import { iconButton } from './editorPanel.js';

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const button = (text, onClick, props = {}) => el('button', { type: 'button', textContent: text, onclick: onClick, ...props });

const km = (metres) => longDistanceValue(metres / 1000).toFixed(2);

/** One button per surface, its colour chip in front. */
function surfaceButtons(onPick) {
  return STAGE_SURFACE_IDS.map((id) => {
    const btn = button(STAGE_SURFACES[id].label, () => onPick(id));
    btn.style.setProperty('--editor-swatch', STAGE_SURFACES[id].color);
    return btn;
  });
}

/** @param {ReturnType<import('../app/scenarioEditor.js').createScenarioEditor>} editor */
export function createSurfacePanel(editor) {
  const { state } = editor;
  const root = document.getElementById('surface-panel');

  const toggle = button('Surfaces', null, { className: 'editor-toggle debug-fold-title' });
  const newButtons = surfaceButtons((id) => editor.setNewSectionSurface(id));
  const startButton = iconButton('startAt', 'Start at car', () => editor.markSectionStart(), {
    title: 'The new section starts where the car is on the stage road (from the start through splits and passage controls to the finish).',
  });
  const endButton = iconButton('endAt', 'End at car', () => editor.markSectionEnd(), {
    title: 'The new section ends where the car is. It wins over the sections it overlaps; touching ones of the same surface join.',
  });
  const cancelButton = button('Cancel', () => editor.cancelSectionStart());
  const summaryEl = el('p', { className: 'editor-note' });
  const listEl = el('ol', { className: 'editor-items surface-list' });

  const surfaceEls = surfaceButtons((id) => editor.setSectionSurface(id));
  const selectedEl = el('div', { className: 'editor-selected' }, [
    el('div', { className: 'editor-buttons editor-kinds editor-place' }, surfaceEls),
    el('div', { className: 'editor-buttons' }, [
      iconButton('goTo', 'Go to', () => editor.goToSection(), { title: 'Teleport to the start of this section' }),
      iconButton('delete', 'Delete', () => editor.deleteSection()),
    ]),
  ]);
  const hintEl = el('p', {
    className: 'editor-note',
    textContent: 'Across the road’s full width, junctions included; crossing roads keep their own surface beyond it. Settings > Graphics > Road surface view shows them. Pacenotes call the changes.',
  });

  root.replaceChildren(
    toggle,
    el('div', { className: 'pacenote-body' }, [
      el('div', { className: 'editor-buttons editor-kinds editor-place' }, newButtons),
      el('div', { className: 'editor-buttons' }, [startButton, endButton, cancelButton]),
      summaryEl,
      listEl,
      selectedEl,
      hintEl,
    ])
  );

  function render() {
    root.hidden = editor.kind().id !== 'stage';
    if (root.hidden) return;
    const surfaces = state.doc.surfaces ?? [];
    toggle.textContent = surfaces.length ? `Surfaces (${surfaces.length})` : 'Surfaces';
    for (const [i, btn] of newButtons.entries()) btn.classList.toggle('active', STAGE_SURFACE_IDS[i] === state.newSectionSurface);
    const marking = state.sectionStart != null;
    summaryEl.textContent = marking
      ? `${STAGE_SURFACES[state.newSectionSurface].label} from ${km(state.sectionStart)} ${longDistanceUnit()}: drive to its end.`
      : surfaces.length
        ? 'Elsewhere the road’s own surface (OSM).'
        : 'None: pick a surface, Start at car, drive, End at car.';
    listEl.replaceChildren(
      ...surfaces.map((section, i) => {
        const li = el('li', {
          textContent: `${STAGE_SURFACES[section.surface].label} ${km(section.from)}–${km(section.to)} ${longDistanceUnit()}`,
          onclick: () => editor.selectSection(i),
        });
        li.style.setProperty('--editor-swatch', STAGE_SURFACES[section.surface].color);
        li.classList.toggle('selected', i === state.selectedSection);
        return li;
      })
    );
    const section = surfaces[state.selectedSection];
    selectedEl.hidden = !section;
    if (section) for (const [i, btn] of surfaceEls.entries()) btn.classList.toggle('active', STAGE_SURFACE_IDS[i] === section.surface);
    for (const btn of root.querySelectorAll('button')) btn.disabled = btn !== toggle && state.busy;
    endButton.disabled = state.busy || !marking;
    cancelButton.hidden = !marking;
  }

  editor.subscribe(render);
}
