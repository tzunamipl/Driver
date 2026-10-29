// Pacenotes window (left side, scenario editor, stages only): generate the edited version's notes, the
// list of calls, and the selected note's direction / grade / junction / sign (steep descent or care), a crest call's crest / jump / care
// (surface calls: only go to / delete, they follow the Surfaces window). Notes are also picked
// by clicking their tiles in the world (app/editorNotePicking.js). Patched on every editor change.

import { DIRS, GRADES, CRESTS, callText } from '../lib/rally/pacenoteCalls.js';
import { longDistanceValue, longDistanceUnit } from '../lib/units.js';
import { iconButton } from './editorPanel.js';

const DIR_LABELS = { L: 'Left', R: 'Right', S: 'Straight' };
const DEFAULT_DESCENT = 10; // % when ticked by hand
const MAX_DESCENT = 40;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const button = (text, onClick, props = {}) => el('button', { type: 'button', textContent: text, onclick: onClick, ...props });

/** @param {ReturnType<import('../app/scenarioEditor.js').createScenarioEditor>} editor */
export function createPacenotePanel(editor) {
  const { state } = editor;
  const root = document.getElementById('pacenote-panel');

  const toggle = button('Pacenotes', null, { className: 'editor-toggle debug-fold-title' });
  const generateButton = iconButton('generate', 'Generate', () => editor.generatePacenotes(), {
    title: 'Corners (L/R, 1 = slowest .. 6 = fastest), distances and junctions along the OSM road from the start through splits and passage controls to the finish. Generate again after moving those points.',
  });
  const addButton = iconButton('add', 'Add at car', () => editor.addNote(), {
    title: 'A note where the car is on the stage road: the corner ahead gives its direction, grade and apex. Adjust it afterwards.',
  });
  const crestButton = iconButton('add', 'Crest at car', () => editor.addNote(true), {
    title: 'A crest call where the car is on the stage road: the top found nearby (crest or jump), else a crest at the car.',
  });
  const bothInput = el('input', { type: 'checkbox' });
  bothInput.addEventListener('change', () => editor.setGenerateBoth(bothInput.checked));
  const bothRow = el('label', { className: 'editor-check', title: 'Generate makes the forward and the reverse version\'s pacenotes at once (both replaced). Off: only the version being edited.' }, [bothInput, 'Both versions']);
  const boardsInput = el('input', { type: 'checkbox' });
  boardsInput.addEventListener('change', () => editor.setShowNoteBoards(boardsInput.checked));
  const boardsRow = el('label', { className: 'editor-check', title: 'Note boards standing on the road at each corner, clickable to select.' }, [boardsInput, 'Show boards on road']);
  const summaryEl = el('p', { className: 'editor-note' });
  const listEl = el('ol', { className: 'editor-items editor-notes' });

  const dirButtons = DIRS.map((d) => button(DIR_LABELS[d], () => editor.setNoteField('dir', d)));
  const gradeButtons = GRADES.map((g) => button(String(g), () => editor.setNoteField('grade', g)));
  const junctionInput = el('input', { type: 'checkbox' });
  junctionInput.addEventListener('change', () => editor.setNoteField('junction', junctionInput.checked));
  const descentInput = el('input', { type: 'checkbox' });
  const descentValue = el('input', { type: 'number', min: 1, max: MAX_DESCENT, step: 1, className: 'pacenote-descent-value' });
  descentInput.addEventListener('change', () => editor.setNoteField('descent', descentInput.checked ? Math.round(Number(descentValue.value)) || DEFAULT_DESCENT : 0));
  descentValue.addEventListener('change', () => {
    const value = Math.round(Number(descentValue.value));
    if (value > 0) editor.setNoteField('descent', Math.min(MAX_DESCENT, value));
  });
  const cornerEl = el('div', { className: 'pacenote-corner' }, [
    el('div', { className: 'editor-buttons editor-kinds' }, dirButtons),
    el('div', { className: 'editor-buttons editor-kinds' }, gradeButtons),
    el('label', { className: 'editor-check', title: 'The stage turns off the natural way here (or goes straight on where the road bends away).' }, [junctionInput, 'At junction']),
    el('label', { className: 'editor-check', title: 'The road drops steeply into this corner (average %): a steep descent sign on the note.' }, [descentInput, 'Steep descent', descentValue, '%']),
  ]);
  const cautionInput = el('input', { type: 'checkbox' });
  cautionInput.addEventListener('change', () => editor.setNoteField('caution', cautionInput.checked));
  const cautionRow = el('label', { className: 'editor-check', title: 'A care sign on the note (replaces a steep descent sign: one sign per note).' }, [cautionInput, 'Care sign']);
  const crestButtons = Object.entries(CRESTS).map(([id, label]) => button(label, () => editor.setNoteField('crest', id)));
  const crestEl = el('div', { className: 'editor-buttons editor-kinds', title: 'Crest: over a top. Jump: sharp enough to take off at speed.' }, crestButtons);
  const noteEl = el('div', { className: 'editor-selected pacenote-selected' }, [
    cornerEl,
    crestEl,
    cautionRow,
    el('div', { className: 'editor-buttons' }, [
      iconButton('goTo', 'Go to', () => editor.goToNote(), { title: 'Teleport to this note' }),
      iconButton('delete', 'Delete', () => editor.deleteNote()),
    ]),
  ]);
  const hintEl = el('p', { className: 'editor-note' });

  root.replaceChildren(toggle, el('div', { className: 'pacenote-body' }, [el('div', { className: 'editor-buttons' }, [generateButton, addButton, crestButton]), bothRow, boardsRow, summaryEl, listEl, noteEl, hintEl]));

  let shownSelection = null;

  function render() {
    root.hidden = editor.kind().id !== 'stage';
    if (root.hidden) return;
    const pacenotes = editor.notes();
    const notes = pacenotes?.notes ?? [];
    hintEl.textContent = state.showNoteBoards ? 'Click a note here or its board on the road.' : 'Click a note to select it.';
    const version = state.reverse ? 'Reverse pacenotes' : 'Pacenotes';
    toggle.textContent = notes.length ? `${version} (${notes.length})` : version;
    summaryEl.textContent = notes.length
      ? `${longDistanceValue(pacenotes.length / 1000).toFixed(1)} ${longDistanceUnit()}, start to finish${state.reverse ? ' of the reverse version' : ''}`
      : state.reverse
        ? 'None yet: Generate them for the reverse version (without them it runs with no pacenotes).'
        : 'None yet: place the start and finish, then Generate.';
    listEl.replaceChildren(
      ...notes.map((_, i) => {
        const li = el('li', { textContent: callText(pacenotes, i), onclick: () => editor.selectNote(i) });
        li.classList.toggle('selected', i === state.selectedNote);
        return li;
      })
    );
    boardsInput.checked = state.showNoteBoards;
    bothInput.checked = state.generateBoth;
    bothInput.disabled = state.busy;
    const note = notes[state.selectedNote];
    noteEl.hidden = !note;
    cornerEl.hidden = !!(note?.surface || note?.crest);
    crestEl.hidden = !note?.crest;
    cautionRow.hidden = !!note?.surface;
    if (note) {
      for (const [i, btn] of dirButtons.entries()) btn.classList.toggle('active', DIRS[i] === note.dir);
      for (const [i, btn] of gradeButtons.entries()) btn.classList.toggle('active', GRADES[i] === note.grade);
      for (const [i, btn] of crestButtons.entries()) btn.classList.toggle('active', Object.keys(CRESTS)[i] === note.crest);
      junctionInput.checked = !!note.junction;
      descentInput.checked = !!note.descent;
      cautionInput.checked = !!note.caution;
      if (document.activeElement !== descentValue) descentValue.value = note.descent ?? DEFAULT_DESCENT;
    }
    // Picked in the world: bring it into view in the list.
    if (state.selectedNote !== shownSelection) {
      shownSelection = state.selectedNote;
      listEl.children[state.selectedNote]?.scrollIntoView({ block: 'nearest' });
    }
    for (const btn of root.querySelectorAll('button')) btn.disabled = btn !== toggle && state.busy;
    // Straight on has no grade and is always a junction call.
    if (note?.dir === 'S') for (const btn of gradeButtons) btn.disabled = true;
    junctionInput.disabled = state.busy || note?.dir === 'S';
    // Only corners are called on a descent.
    descentInput.disabled = descentValue.disabled = state.busy || note?.dir === 'S';
    cautionInput.disabled = state.busy;
  }

  editor.subscribe(render);
}
