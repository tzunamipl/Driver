// Scenario editor panel (top right): file kind/id/name, place-at-car buttons for the
// mode's point types, the ordered item list, the selected item's fields (road snap,
// road orientation and a heading dial for gates), save/export, and an Open window with the scenario tree.
// Built once and patched on change, so typing in a field keeps its focus.

import { branchNameFor } from '../lib/scenarios/publish.js';
import { splitKey, slugLabel } from '../lib/scenarios/paths.js';
import { createScenarioTree } from './scenarioTree.js';

const hex = (color) => `#${color.toString(16).padStart(6, '0')}`;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const button = (text, onClick, props = {}) => el('button', { type: 'button', textContent: text, onclick: onClick, ...props });

/** Marks `node` for the panel's hover tooltip: a bold heading over the text. */
export function setTip(node, heading, text) {
  node.dataset.tipHeading = heading;
  node.dataset.tip = text;
}

/**
 * Instant tooltip right of the mouse for `root`'s setTip() nodes (native titles show late).
 * hideIfDetached(): call after rebuilding a list, the hovered row may be gone.
 */
export function attachTips(root) {
  const tipEl = el('div', { className: 'editor-tip', hidden: true });
  document.body.append(tipEl);
  let tipTarget = null;
  function showTip(target) {
    tipTarget = target;
    tipEl.replaceChildren(el('b', { textContent: target.dataset.tipHeading }), el('p', { textContent: target.dataset.tip }));
    tipEl.hidden = false;
  }
  function placeTip(x, y) {
    tipEl.style.left = `${Math.max(4, Math.min(x + 14, window.innerWidth - tipEl.offsetWidth - 4))}px`;
    tipEl.style.top = `${Math.max(4, Math.min(y + 14, window.innerHeight - tipEl.offsetHeight - 4))}px`;
  }
  function hideTip() {
    tipTarget = null;
    tipEl.hidden = true;
  }
  root.addEventListener('pointerover', (e) => {
    const target = e.target.closest('[data-tip]');
    if (target !== tipTarget) target ? showTip(target) : hideTip();
  });
  root.addEventListener('pointermove', (e) => {
    if (tipTarget) placeTip(e.clientX, e.clientY);
  });
  root.addEventListener('pointerleave', hideTip);
  return {
    hideIfDetached() {
      if (tipTarget && !tipTarget.isConnected) hideTip();
    },
  };
}

/** Sets an input's value unless the player is typing in it. */
export function patchValue(input, value) {
  if (document.activeElement !== input && input.value !== value) input.value = value;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const DIAL_STEP_DEG = 15; // Shift-drag and Shift+arrow steps

function svg(tag, attrs, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

const GATE_HEADING_TIP =
  'Direction of travel through the gate (0° = north). Drag the dial (Shift: 15° steps) or use the arrow keys; turning it unticks Road orientation. Dashed = the road it follows now.';

/**
 * Compass dial for a gate's direction of travel (north up): drag or arrow keys to turn,
 * degrees field. A dashed needle is the road's direction.
 * @param {(degrees: number | null) => void} onChange
 * @param {string} [tip] - hover text.
 */
export function createHeadingDial(onChange, tip = GATE_HEADING_TIP) {
  const needle = svg('g', { class: 'editor-dial-needle' }, [svg('line', { x1: 0, y1: 6, x2: 0, y2: -14 }), svg('path', { d: 'M0 -17 L-4 -10 L4 -10 Z' })]);
  const face = svg('svg', { viewBox: '-20 -20 40 40', class: 'editor-dial', tabindex: 0 }, [
    svg('circle', { r: 19 }),
    svg('text', { y: -11, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, ['N']),
    needle,
  ]);
  let current = null;
  const turnTo = (degrees, step) => onChange(Math.round(degrees / step) * step);
  const fromPointer = (e) => {
    const box = face.getBoundingClientRect();
    const dx = e.clientX - (box.left + box.width / 2);
    const dy = e.clientY - (box.top + box.height / 2);
    turnTo((Math.atan2(dx, -dy) * 180) / Math.PI, e.shiftKey ? DIAL_STEP_DEG : 1);
  };
  face.addEventListener('pointerdown', (e) => {
    face.setPointerCapture(e.pointerId);
    fromPointer(e);
  });
  face.addEventListener('pointermove', (e) => face.hasPointerCapture(e.pointerId) && fromPointer(e));
  face.addEventListener('keydown', (e) => {
    const sign = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!sign) return;
    e.preventDefault();
    // The game's keys stay off while turning the dial.
    e.stopPropagation();
    turnTo((current ?? 0) + sign * (e.shiftKey ? DIAL_STEP_DEG : 1), 1);
  });
  const input = el('input', { type: 'number', min: 0, max: 359, step: 1, placeholder: 'road' });
  input.addEventListener('input', () => input.value !== '' && Number.isFinite(Number(input.value)) && onChange(Number(input.value)));
  const node = el('div', { className: 'editor-dial-row' }, [face, el('div', {}, [input, ' °'])]);
  setTip(node, 'Heading', tip);

  return {
    el: node,
    /** @param {number | null} heading - shown direction; @param {boolean} manual - set by hand (else the road's). */
    set(heading, manual) {
      current = heading;
      needle.style.display = heading == null ? 'none' : '';
      if (heading != null) needle.setAttribute('transform', `rotate(${heading})`);
      needle.classList.toggle('is-road', !manual);
      patchValue(input, manual ? String(Math.round(heading)) : '');
    },
  };
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
  const countryInput = el('input', { type: 'text', placeholder: 'poland', spellcheck: false });
  countryInput.addEventListener('input', () => editor.setMeta('country', countryInput.value.trim()));
  const regionInput = el('input', { type: 'text', placeholder: 'bieszczady', spellcheck: false, title: 'Region or theme the file is filed under' });
  regionInput.addEventListener('input', () => editor.setMeta('region', regionInput.value.trim()));
  const idInput = el('input', { type: 'text', placeholder: 'my-stage', spellcheck: false });
  idInput.addEventListener('input', () => editor.setMeta('id', idInput.value.trim()));
  const nameInput = el('input', { type: 'text', placeholder: 'Name' });
  nameInput.addEventListener('input', () => editor.setMeta('name', nameInput.value));
  // Kinds with a day clock (`startTime` = its default) take a start time.
  const startTimeInput = el('input', { type: 'text', spellcheck: false });
  startTimeInput.addEventListener('input', () => editor.setMeta('startTime', startTimeInput.value.trim()));
  const startTimeLabel = el('label', { textContent: 'Start time' });
  setTip(startTimeLabel, 'Start time', 'Local time at the rally when day 1 starts (HH:MM). The clock then runs at real speed; service, field fixes and skipped liaisons add their time, and each parc fermé ends a day.');

  const placeEl = el('div', { className: 'editor-place' });
  // Stage picker: country, then region / theme, then the stage.
  const refCountry = el('select', { title: 'Country' });
  const refRegion = el('select', { title: 'Region / theme' });
  const refStage = el('select', { title: 'Special stage' });
  refCountry.addEventListener('change', () => renderRefPicker());
  refRegion.addEventListener('change', () => renderRefPicker());
  const refNote = el('p', { className: 'editor-note' });
  const refRow = el('div', { className: 'editor-ref' }, [
    el('div', { className: 'editor-heading', textContent: 'Add stage' }),
    refCountry,
    refRegion,
    el('div', { className: 'editor-buttons' }, [refStage, button('Add', () => editor.addRef(refStage.value))]),
    refNote,
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
  const saveButton = button('Publish', async () => {
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
    ownBranch: () => branchNameFor(getPlayerName()),
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
  const statusEl = el('p', { className: 'editor-status' });
  const toggle = el('button', { type: 'button', className: 'editor-toggle', textContent: title });
  // Two columns: the file and what to place on the left, the item list and its editing on the right.
  const body = el('div', { className: 'editor-body' }, [
    el('div', { className: 'editor-column' }, [
      el('div', { className: 'editor-buttons editor-kinds' }, [...kindButtons, newButton, openButton]),
      el('label', { textContent: 'Country' }),
      countryInput,
      el('label', { textContent: 'Region / theme' }),
      regionInput,
      el('label', { textContent: 'ID' }),
      idInput,
      el('label', { textContent: 'Name' }),
      nameInput,
      startTimeLabel,
      startTimeInput,
      el('div', { className: 'editor-heading', textContent: 'Place at car' }),
      placeEl,
      refRow,
    ]),
    el('div', { className: 'editor-column' }, [itemsEl, selectedEl, actionsEl, exportEl, branchEl, statusEl]),
  ]);
  toggle.addEventListener('click', () => root.classList.toggle('collapsed'));
  root.replaceChildren(toggle, body);

  const tips = attachTips(root);

  function download() {
    const blob = new Blob([exportText.value], { type: 'application/json' });
    const link = el('a', { href: URL.createObjectURL(blob), download: editor.fileName().split('/').pop() });
    link.click();
    URL.revokeObjectURL(link.href);
  }

  /** Point type of an item: its own, or for a repeat the type of the gate it drives again. */
  const typeDef = (item, i) => format.pointTypes[item.type === 'pointRef' ? editor.repeatTarget(i)?.type : item.type];

  function itemLabel(item, i) {
    if (item.type === 'ref') return `Stage: ${item.ref}${item.name ? ` (${item.name})` : ''}${editor.refListed(item.ref) ? '' : ' · not on the publish branch'}`;
    if (item.type === 'pointRef') {
      const target = editor.repeatTarget(i);
      return target ? `↻ ${format.pointTypes[target.type].label} · ${item.ref} (${state.doc.items.indexOf(target) + 1})` : `↻ Missing point "${item.ref}"`;
    }
    const def = format.pointTypes[item.type];
    if (def.gate) return `${def.label}${item.id ? ` · ${item.id}` : ''} · ${item.width} m${Number.isFinite(item.heading) ? ` · ${Math.round(item.heading)}°` : ''}`;
    return item.name ? `${def.label}: ${item.name}` : def.label;
  }

  let renderedKind = null;
  let renderedSelection = null;
  let dial = null; // the selected gate's heading dial
  let gateChecks = null; // the selected gate's { snap, road } checkboxes

  function renderPlace(kind) {
    placeEl.replaceChildren(
      ...kind.points.map((type) => {
        const def = format.pointTypes[type];
        const btn = button(def.short, () => editor.place(type));
        setTip(btn, `Place ${def.label}`, def.description);
        btn.style.setProperty('--editor-swatch', hex(def.color));
        return btn;
      })
    );
  }

  function check(label, tip, onChange) {
    const input = el('input', { type: 'checkbox' });
    input.addEventListener('change', () => onChange(input.checked));
    const row = el('label', { className: 'editor-check' }, [input, label]);
    setTip(row, label, tip);
    return { input, row };
  }

  const orderButtons = () => [
    button('▲', () => editor.shiftSelected(-1), { title: 'Earlier' }),
    button('▼', () => editor.shiftSelected(1), { title: 'Later' }),
    button('Delete', () => editor.deleteSelected()),
  ];

  function renderSelected(item) {
    dial = null;
    gateChecks = null;
    if (!item) return selectedEl.replaceChildren();
    if (item.type === 'pointRef') {
      const note = el('p', {
        className: 'editor-note',
        textContent: 'Drives the same gate again here. Its position, width and heading are edited on the original.',
      });
      return selectedEl.replaceChildren(
        note,
        el('div', { className: 'editor-buttons' }, [button('Select original', () => editor.selectOriginal()), button('Repeat', () => editor.repeatSelected()), ...orderButtons()])
      );
    }
    const fields = [];
    const isRef = item.type === 'ref';
    const repeatable = !isRef && editor.kind().pointRefs && format.pointTypes[item.type].gate;
    if (repeatable) {
      const id = el('input', { type: 'text', value: item.id ?? '', placeholder: 'set by Repeat', spellcheck: false });
      id.addEventListener('input', () => editor.setPointId(id.value.trim()));
      const label = el('label', { textContent: 'Point ID' });
      setTip(label, 'Point ID', 'Names this gate in the file so later itinerary entries can drive it again (Repeat). Lowercase letters, digits and dashes.');
      fields.push(label, id);
    }
    if (!isRef && format.pointTypes[item.type].gate) {
      const width = el('input', { type: 'number', min: 1, max: 60, step: 0.5, value: item.width });
      width.addEventListener('input', () => {
        const value = Number(width.value);
        if (value > 0) editor.setField('width', value);
      });
      fields.push(el('label', { textContent: 'Width (m)' }), width);
      const snap = check('Snap position to road', 'On: stands across the nearest road\'s centreline, its boards along the road. Off: exactly at its point (Move to car = where the car is), boards in a straight line, even off-road.', (on) => editor.setSnap(on));
      const road = check('Road orientation', 'On: faces along the nearest road, in driving order. Off: faces the heading set on the dial (Move to car = the way the car faces).', (on) => editor.setRoadOrientation(on));
      gateChecks = { snap: snap.input, road: road.input };
      dial = createHeadingDial((degrees) => editor.setHeading(degrees));
      fields.push(el('label', { textContent: 'Heading' }), el('div', { className: 'editor-heading-row' }, [dial.el, el('div', { className: 'editor-checks' }, [snap.row, road.row])]));
      if (format.pointTypes[item.type].endsDay) {
        const nextStart = el('input', { type: 'text', value: item.nextStart ?? '', placeholder: state.doc.startTime || editor.kind().startTime, spellcheck: false });
        nextStart.addEventListener('input', () => editor.setField('nextStart', nextStart.value.trim()));
        const label = el('label', { textContent: 'Next day start' });
        setTip(label, 'Next day start', 'Local time (HH:MM) the next rally day starts at after this parc fermé. Empty: the rally start time.');
        fields.push(label, nextStart);
      }
    } else {
      const name = el('input', { type: 'text', value: item.name ?? '', placeholder: isRef ? 'Name for this pass (optional)' : 'Name' });
      name.addEventListener('input', () => editor.setField('name', name.value));
      fields.push(el('label', { textContent: 'Name' }), name);
    }
    selectedEl.replaceChildren(
      ...fields,
      el('div', { className: 'editor-buttons' }, [
        ...(isRef ? [] : [button('Move to car', () => editor.moveSelectedToCar())]),
        ...(repeatable ? [button('Repeat', () => editor.repeatSelected(), { title: 'Drive this gate again: adds a linked copy after the selection' })] : []),
        ...orderButtons(),
      ])
    );
  }

  /** Refills `select` with `values` only when they changed (keeps an open dropdown); keeps its pick, else `preferred`. */
  function fillSelect(select, values, label, preferred, empty) {
    const signature = JSON.stringify(values.map((v) => [v, label(v)]));
    if (select.dataset.signature !== signature) {
      select.dataset.signature = signature;
      const current = select.value;
      select.replaceChildren(...(values.length ? values.map((v) => el('option', { value: v, textContent: label(v) })) : [el('option', { value: '', textContent: empty })]));
      select.value = values.includes(current) ? current : values.includes(preferred) ? preferred : values[0] ?? '';
    }
    select.disabled = !values.length;
  }

  function renderRefPicker() {
    const refKind = format.kinds.find((k) => k.id === editor.kind().refKind);
    const keys = [...(state.index?.[refKind.indexKey] ?? [])].sort();
    const parts = keys.map((key) => ({ key, ...splitKey(key) }));
    const unique = (list) => [...new Set(list)];
    const folderLabel = (slug) => slugLabel(slug) || 'No folder';
    const empty = state.index ? 'None' : 'Loading…';
    // A new rally usually uses stages of its own folder.
    fillSelect(refCountry, unique(parts.map((p) => p.country)), folderLabel, state.doc.country, empty);
    const inCountry = parts.filter((p) => p.country === refCountry.value);
    fillSelect(refRegion, unique(inCountry.map((p) => p.region)), folderLabel, state.doc.region, empty);
    const stageKeys = inCountry.filter((p) => p.region === refRegion.value).map((p) => p.key);
    editor.loadRefNames(stageKeys);
    fillSelect(refStage, stageKeys, (key) => state.refNames[key] || splitKey(key).id, null, empty);
    refNote.textContent = `From ${state.source}, the branch Publish goes to`;
  }

  function render() {
    const kind = editor.kind();
    for (const btn of kindButtons) btn.classList.toggle('active', btn.dataset.kind === kind.id);
    patchValue(countryInput, state.doc.country);
    patchValue(regionInput, state.doc.region);
    patchValue(idInput, state.doc.id);
    patchValue(nameInput, state.doc.name);
    patchValue(startTimeInput, state.doc.startTime ?? '');
    startTimeLabel.hidden = startTimeInput.hidden = !kind.startTime;
    startTimeInput.placeholder = kind.startTime ?? '';
    sourceNote.textContent = `Stages are added from ${state.source}, the branch Publish goes to.`;
    if (renderedKind !== kind.id) {
      renderedKind = kind.id;
      renderPlace(kind);
    }

    refRow.hidden = !kind.refKind;
    if (kind.refKind) renderRefPicker();

    itemsEl.replaceChildren(
      ...state.doc.items.map((item, i) => {
        const def = typeDef(item, i);
        const li = el('li', { textContent: itemLabel(item, i), onclick: () => editor.select(i) });
        const tip = item.type === 'pointRef' ? 'The same gate as the one numbered in brackets, driven again here.' : def?.description;
        setTip(li, `${i + 1}. ${itemLabel(item, i)}`, tip ?? 'A stage driven at this point of the rally.');
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
    dial?.set(editor.headingOf(state.selected), Number.isFinite(item.heading));
    if (gateChecks) {
      gateChecks.snap.checked = item.snap !== false;
      gateChecks.road.checked = !Number.isFinite(item.heading);
    }

    // The list was rebuilt: the hovered row is gone.
    tips.hideIfDetached();
    branchEl.textContent = `Publishing goes to branch "${branchNameFor(getPlayerName())}" (shared by everyone with your name) and are sent for review.`;
    for (const btn of root.querySelectorAll('button')) btn.disabled = state.busy && btn !== toggle;
    statusEl.textContent = state.status.text;
    statusEl.classList.toggle('is-error', state.status.error);
  }

  editor.subscribe(render);
  editor.loadIndex();
}
