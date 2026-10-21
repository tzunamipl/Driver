// Scenario editor panel (top right): file kind/id/name, place-at-car buttons for the
// mode's point types, the ordered item list, the selected item's fields, save/export, and
// an Open window with the scenario tree.
// Built once and patched on change, so typing in a field keeps its focus.

import { TOKEN_HELP_URL, branchNameFor } from '../lib/scenarios/github.js';
import { createScenarioTree } from './scenarioTree.js';

const hex = (color) => `#${color.toString(16).padStart(6, '0')}`;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const button = (text, onClick, props = {}) => el('button', { type: 'button', textContent: text, onclick: onClick, ...props });

/** Sets an input's value unless the player is typing in it. */
function patchValue(input, value) {
  if (document.activeElement !== input && input.value !== value) input.value = value;
}

/**
 * @param {ReturnType<import('../app/scenarioEditor.js').createScenarioEditor>} editor
 * @param {object} opts
 * @param {string} opts.title
 * @param {() => string | null} opts.getPlayerName
 * @param {() => void} opts.openSettings - shows the main menu's Settings screen.
 */
export function createEditorPanel(editor, { title, getPlayerName, openSettings }) {
  const { format, state } = editor;
  const root = document.getElementById('editor-panel');
  root.hidden = false;

  const kindButtons = format.kinds.map((kind) => {
    const btn = button(kind.label, () => kind.id !== state.doc.kind && editor.newDoc(kind.id));
    btn.dataset.kind = kind.id;
    return btn;
  });
  const newButton = button('New', () => editor.newDoc(state.doc.kind));
  const idInput = el('input', { type: 'text', placeholder: 'my-stage', spellcheck: false });
  idInput.addEventListener('input', () => editor.setMeta('id', idInput.value.trim()));
  const nameInput = el('input', { type: 'text', placeholder: 'Name' });
  nameInput.addEventListener('input', () => editor.setMeta('name', nameInput.value));

  const placeEl = el('div', { className: 'editor-place' });
  const refSelect = el('select');
  const refRow = el('div', { className: 'editor-ref' }, [
    refSelect,
    button('Add stage', () => editor.addRef(refSelect.value)),
  ]);
  const itemsEl = el('ol', { className: 'editor-items' });
  const selectedEl = el('div', { className: 'editor-selected' });

  const exportText = el('textarea', { readOnly: true, rows: 10, spellcheck: false });
  const exportEl = el('div', { className: 'editor-export', hidden: true }, [
    exportText,
    el('div', { className: 'editor-buttons' }, [
      button('Copy', () => navigator.clipboard?.writeText(exportText.value)),
      button('Download', download),
      button('Close', () => (exportEl.hidden = true)),
    ]),
  ]);
  const saveButton = button('Save to GitHub', async () => {
    tokenHelpEl.hidden = editor.hasToken();
    if (!tokenHelpEl.hidden) return;
    await editor.save();
    tree.reload();
  });
  const actionsEl = el('div', { className: 'editor-buttons' }, [
    button('Go to', () => editor.goToSelected(), { title: 'Teleport to the selected point' }),
    button('Export', () => {
      exportText.value = editor.exportJson();
      exportEl.hidden = false;
    }),
    saveButton,
  ]);

  const tree = createScenarioTree({
    folder: format.folder,
    kinds: format.kinds,
    getToken: editor.getToken,
    onPick: (pick) => {
      openDialog.hidden = true;
      editor.openPicked(pick);
    },
  });
  const sourceNote = el('p', { className: 'editor-note' });
  // Menu-style window over the world; a click on the backdrop closes it too.
  const openDialog = el('div', { id: 'editor-open', hidden: true }, [
    el('div', { className: 'menu-window editor-open-window' }, [
      el('h1', { className: 'menu-titlebar', textContent: `Open · ${title}` }),
      tree.el,
      sourceNote,
      el('div', { className: 'menu-footer' }, [button('Cancel', () => (openDialog.hidden = true))]),
    ]),
  ]);
  openDialog.addEventListener('click', (e) => {
    if (e.target === openDialog) openDialog.hidden = true;
  });
  document.body.append(openDialog);
  const openButton = button('Open…', () => (openDialog.hidden = false), { title: 'Open a file from a scenario source' });

  const branchEl = el('p', { className: 'editor-note' });
  const tokenHelpEl = el('div', { className: 'editor-token-help', hidden: true }, [
    el('p', { textContent: 'Saving commits this file to a branch of your fork of the scenarios repo, so it needs a GitHub token:' }),
    el('ol', {}, [
      el('li', {}, [
        el('a', { href: TOKEN_HELP_URL, target: '_blank', rel: 'noopener noreferrer', textContent: 'Create a token' }),
        ' (classic, public_repo scope) on GitHub.',
      ]),
      el('li', { textContent: 'Paste it in Settings → GitHub (Esc → Settings).' }),
      el('li', { textContent: 'Press Save to GitHub again.' }),
    ]),
    el('div', { className: 'editor-buttons' }, [
      button('Open Settings', openSettings),
      button('Close', () => (tokenHelpEl.hidden = true)),
    ]),
  ]);

  const statusEl = el('p', { className: 'editor-status' });
  const toggle = el('button', { type: 'button', className: 'editor-toggle', textContent: title });
  const body = el('div', { className: 'editor-body' }, [
    el('div', { className: 'editor-buttons editor-kinds' }, [...kindButtons, newButton, openButton]),
    el('label', { textContent: 'ID' }),
    idInput,
    el('label', { textContent: 'Name' }),
    nameInput,
    el('div', { className: 'editor-heading', textContent: 'Place at car' }),
    placeEl,
    refRow,
    itemsEl,
    selectedEl,
    actionsEl,
    exportEl,
    tokenHelpEl,
    branchEl,
    statusEl,
  ]);
  toggle.addEventListener('click', () => root.classList.toggle('collapsed'));
  root.replaceChildren(toggle, body);

  function download() {
    const blob = new Blob([exportText.value], { type: 'application/json' });
    const link = el('a', { href: URL.createObjectURL(blob), download: editor.fileName().split('/').pop() });
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function itemLabel(item) {
    if (item.type === 'ref') return `Stage: ${item.ref}${item.name ? ` (${item.name})` : ''}`;
    const def = format.pointTypes[item.type];
    if (def.gate) return `${def.label} · ${item.width} m`;
    return item.name ? `${def.label}: ${item.name}` : def.label;
  }

  let renderedKind = null;
  let renderedSelection = null;

  function renderPlace(kind) {
    placeEl.replaceChildren(
      ...kind.points.map((type) => {
        const def = format.pointTypes[type];
        const btn = button(def.short, () => editor.place(type), { title: `${def.label}: ${def.description}` });
        btn.style.setProperty('--editor-swatch', hex(def.color));
        return btn;
      })
    );
  }

  function renderSelected(item) {
    if (!item) return selectedEl.replaceChildren();
    const fields = [];
    const isRef = item.type === 'ref';
    if (!isRef && format.pointTypes[item.type].gate) {
      const width = el('input', { type: 'number', min: 1, max: 60, step: 0.5, value: item.width });
      width.addEventListener('input', () => {
        const value = Number(width.value);
        if (value > 0) editor.setField('width', value);
      });
      fields.push(el('label', { textContent: 'Width (m)' }), width);
    } else {
      const name = el('input', { type: 'text', value: item.name ?? '', placeholder: isRef ? 'Name for this pass (optional)' : 'Name' });
      name.addEventListener('input', () => editor.setField('name', name.value));
      fields.push(el('label', { textContent: 'Name' }), name);
    }
    selectedEl.replaceChildren(
      ...fields,
      el('div', { className: 'editor-buttons' }, [
        ...(isRef ? [] : [button('Move to car', () => editor.moveSelectedToCar())]),
        button('▲', () => editor.shiftSelected(-1), { title: 'Earlier' }),
        button('▼', () => editor.shiftSelected(1), { title: 'Later' }),
        button('Delete', () => editor.deleteSelected()),
      ])
    );
  }

  function render() {
    const kind = editor.kind();
    for (const btn of kindButtons) btn.classList.toggle('active', btn.dataset.kind === kind.id);
    patchValue(idInput, state.doc.id);
    patchValue(nameInput, state.doc.name);
    sourceNote.textContent = `Stages are added from ${state.source}`;
    if (renderedKind !== kind.id) {
      renderedKind = kind.id;
      renderPlace(kind);
    }

    refRow.hidden = !kind.refKind;
    if (kind.refKind) {
      const ids = state.index?.[format.kinds.find((k) => k.id === kind.refKind).indexKey] ?? [];
      const current = refSelect.value;
      refSelect.replaceChildren(
        ...(ids.length ? ids : ['']).map((id) => el('option', { value: id, textContent: id || 'No stages in source' }))
      );
      if (ids.includes(current)) refSelect.value = current;
    }

    itemsEl.replaceChildren(
      ...state.doc.items.map((item, i) => {
        const def = format.pointTypes[item.type];
        const li = el('li', {
          textContent: itemLabel(item),
          title: def?.description ?? 'A stage driven at this point of the rally.',
          onclick: () => editor.select(i),
        });
        li.classList.toggle('selected', i === state.selected);
        if (def) li.style.setProperty('--editor-swatch', hex(def.color));
        return li;
      })
    );
    const item = state.doc.items[state.selected];
    const selection = item ? `${state.selected}|${item.type}|${state.doc.items.length}` : null;
    if (selection !== renderedSelection) {
      renderedSelection = selection;
      renderSelected(item);
    }

    branchEl.textContent = `Saves go to branch "${branchNameFor(getPlayerName())}" of your fork.`;
    for (const btn of root.querySelectorAll('button')) btn.disabled = state.busy && btn !== toggle;
    statusEl.textContent = state.status.text;
    statusEl.classList.toggle('is-error', state.status.error);
  }

  editor.subscribe(render);
  editor.loadIndex();
}
