// Pacenotes window (left side, scenario editor, stages only): generate the edited version's notes, the
// list of calls, and the selected note's direction / grade / junction (surface calls: only go to / delete,
// they follow the Surfaces window). Notes are also picked
// by clicking their tiles in the world (app/editorNotePicking.js). Patched on every editor change.

import { DIRS, GRADES, callText } from '../lib/rally/pacenoteCalls.js';
import { longDistanceValue, longDistanceUnit } from '../lib/units.js';

const DIR_LABELS = { L: 'Left', R: 'Right', S: 'Straight' };

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
  const generateButton = button('Generate', () => editor.generatePacenotes(), {
    title: 'Corners (L/R, 1 = slowest .. 6 = fastest), distances and junctions along the OSM road from the start through splits and passage controls to the finish. Generate again after moving those points.',
  });
  const addButton = button('Add at car', () => editor.addNote(), {
    title: 'A note where the car is on the stage road: the corner ahead gives its direction, grade and apex. Adjust it afterwards.',
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
  const cornerEl = el('div', { className: 'pacenote-corner' }, [
    el('div', { className: 'editor-buttons editor-kinds' }, dirButtons),
    el('div', { className: 'editor-buttons editor-kinds' }, gradeButtons),
    el('label', { className: 'editor-check', title: 'The stage turns off the natural way here (or goes straight on where the road bends away).' }, [junctionInput, 'At junction']),
  ]);
  const noteEl = el('div', { className: 'editor-selected pacenote-selected' }, [
    cornerEl,
    el('div', { className: 'editor-buttons' }, [
      button('Go to', () => editor.goToNote(), { title: 'Teleport to this note' }),
      button('Delete', () => editor.deleteNote()),
    ]),
  ]);
  const hintEl = el('p', { className: 'editor-note' });

  root.replaceChildren(toggle, el('div', { className: 'pacenote-body' }, [el('div', { className: 'editor-buttons' }, [generateButton, addButton]), bothRow, boardsRow, summaryEl, listEl, noteEl, hintEl]));

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
    cornerEl.hidden = !!note?.surface;
    if (note) {
      for (const [i, btn] of dirButtons.entries()) btn.classList.toggle('active', DIRS[i] === note.dir);
      for (const [i, btn] of gradeButtons.entries()) btn.classList.toggle('active', GRADES[i] === note.grade);
      junctionInput.checked = !!note.junction;
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
  }

  editor.subscribe(render);
}
