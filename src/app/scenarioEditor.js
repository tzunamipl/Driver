// Scenario editor session (a game mode's Editor button): free driving plus placing the
// mode's points at the car, snapped across the nearest road. Mode-specific parts come
// from its format (lib/scenarios/formats.js); the panel is ui/editorPanel.js. The draft
// lives in the editor's save slot; Save commits it to the player's branch on GitHub.

import {
  SCENARIOS_REPO,
  OFFICIAL_SCENARIO_SOURCE,
  SCENARIO_FORMAT,
  GITHUB_TOKEN_STORAGE_KEY,
  EDITOR_SOURCE_STORAGE_KEY,
  EDITOR_SNAP_RADIUS_M,
} from '../config.js';
import { readSaveField, writeSaveField } from '../lib/saves.js';
import { parseSource, formatSource, openSource } from '../lib/scenarios/source.js';
import { commitFiles, branchNameFor } from '../lib/scenarios/github.js';
import { snapToRoad } from '../lib/scenarios/roadSnap.js';
import { createGateMarkers } from '../lib/scenarios/gateMarkers.js';

// Points without a known road direction retry the snap this often (streets still loading).
const DIR_RETRY_MS = 1000;

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Storage unavailable: lasts this session only.
  }
}

/**
 * @param {object} deps
 * @param {object} deps.format - the mode's scenario format.
 * @param {() => string | null} deps.getPlayerName - names the branch saves go to.
 */
export function createScenarioEditor({ format, scene, terrain, streets, viewFrame, carManager, addressSearch, getPlayerName }) {
  const markers = createGateMarkers(scene);
  const kindById = new Map(format.kinds.map((kind) => [kind.id, kind]));
  const listeners = new Set();

  const emptyDoc = (kind) => ({ kind, id: '', name: '', items: [] });
  const draft = readSaveField('editorDraft');
  const state = {
    doc: kindById.has(draft?.kind) && Array.isArray(draft.items) ? draft : emptyDoc(format.kinds[0].id),
    selected: -1,
    source: readStored(EDITOR_SOURCE_STORAGE_KEY) ?? OFFICIAL_SCENARIO_SOURCE,
    index: null, // the source's index.json: { [indexKey]: ids }
    status: { text: '', error: false },
    busy: false,
  };
  // item -> { dirX, dirZ } or { failedAt }: road direction for its marker.
  const roadDirs = new WeakMap();

  const kind = () => kindById.get(state.doc.kind);
  const token = () => readStored(GITHUB_TOKEN_STORAGE_KEY);

  function changed({ save = true } = {}) {
    if (save) writeSaveField('editorDraft', state.doc);
    for (const listener of listeners) listener(state);
  }

  function setStatus(text, error = false) {
    state.status = { text, error };
    changed({ save: false });
  }

  function carPosition() {
    return carManager.getVehicle()?.chassisBody.position ?? null;
  }

  /** Point fields for the car's position: snapped onto the road for gates. */
  function pointAtCar(type) {
    const pos = carPosition();
    if (!pos) return null;
    const isGate = format.pointTypes[type].gate;
    const snap = isGate ? snapToRoad(streets, pos.x, pos.z, EDITOR_SNAP_RADIUS_M) : null;
    const { lat, lon } = viewFrame.toLatLon(snap?.x ?? pos.x, snap?.z ?? pos.z);
    return { lat, lon, roadWidth: snap ? Math.ceil(snap.roadWidth) : null, snapped: !!snap };
  }

  function insertItem(item) {
    const at = state.selected >= 0 ? state.selected + 1 : state.doc.items.length;
    state.doc.items.splice(at, 0, item);
    state.selected = at;
  }

  function guard(fn) {
    return async (...args) => {
      if (state.busy) return;
      state.busy = true;
      changed({ save: false });
      try {
        await fn(...args);
      } catch (err) {
        console.warn('Scenario editor:', err);
        setStatus(err.message, true);
      } finally {
        state.busy = false;
        changed({ save: false });
      }
    };
  }

  async function loadIndex() {
    const source = parseSource(state.source);
    if (!source) throw new Error('Source must look like owner/repo@branch');
    const opened = await openSource(source, token());
    const index = (await opened.readJson(`${format.folder}/index.json`)) ?? {};
    return { opened, index };
  }

  function toFileJson() {
    return `${JSON.stringify(kind().toFile(state.doc), null, 2)}\n`;
  }

  const editor = {
    format,
    state,
    kind,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
    },
    hasToken: () => !!token(),
    setToken(value) {
      writeStored(GITHUB_TOKEN_STORAGE_KEY, value.trim());
      changed({ save: false });
    },

    newDoc(kindId) {
      if (state.doc.items.length && !window.confirm('Start a new file? Unsaved points will be lost.')) return;
      state.doc = emptyDoc(kindId);
      state.selected = -1;
      state.status = { text: '', error: false };
      changed();
    },
    setMeta(field, value) {
      state.doc[field] = value;
      changed();
    },

    place(type) {
      const point = pointAtCar(type);
      if (!point) return;
      const def = format.pointTypes[type];
      if (def.single) {
        const existing = state.doc.items.findIndex((item) => item.type === type);
        if (existing >= 0) {
          Object.assign(state.doc.items[existing], { lat: point.lat, lon: point.lon });
          roadDirs.delete(state.doc.items[existing]);
          state.selected = existing;
          return changed();
        }
      }
      const item = { type, lat: point.lat, lon: point.lon };
      if (def.gate) item.width = point.roadWidth ?? format.defaultGateWidth;
      else item.name = '';
      insertItem(item);
      state.status = def.gate && !point.snapped ? { text: 'No road nearby: placed at the car', error: true } : { text: '', error: false };
      changed();
    },
    addRef(id) {
      if (!id) return;
      insertItem({ type: 'ref', ref: id, name: '' });
      changed();
    },
    select(i) {
      state.selected = state.selected === i ? -1 : i;
      changed({ save: false });
    },
    setField(field, value) {
      const item = state.doc.items[state.selected];
      if (!item) return;
      item[field] = value;
      changed();
    },
    moveSelectedToCar() {
      const item = state.doc.items[state.selected];
      if (!item || item.type === 'ref') return;
      const point = pointAtCar(item.type);
      if (!point) return;
      Object.assign(item, { lat: point.lat, lon: point.lon });
      roadDirs.delete(item);
      changed();
    },
    shiftSelected(delta) {
      const { items } = state.doc;
      const to = state.selected + delta;
      if (state.selected < 0 || to < 0 || to >= items.length) return;
      [items[state.selected], items[to]] = [items[to], items[state.selected]];
      state.selected = to;
      changed();
    },
    deleteSelected() {
      if (state.selected < 0) return;
      state.doc.items.splice(state.selected, 1);
      state.selected = Math.min(state.selected, state.doc.items.length - 1);
      changed();
    },
    goToSelected() {
      const item = state.doc.items[state.selected] ?? state.doc.items.find((it) => it.type !== 'ref');
      if (!item || item.type === 'ref') return;
      addressSearch.teleport(item.lat, item.lon, format.pointTypes[item.type].label);
    },

    setSource(text) {
      state.source = text.trim();
      writeStored(EDITOR_SOURCE_STORAGE_KEY, state.source);
      state.index = null;
      changed({ save: false });
    },
    loadIndex: guard(async () => {
      setStatus('Loading…');
      ({ index: state.index } = await loadIndex());
      setStatus(`Loaded ${state.source}`);
    }),
    open: guard(async (kindId, id) => {
      if (state.doc.items.length && !window.confirm(`Open ${id}? Unsaved points will be lost.`)) return;
      setStatus(`Opening ${id}…`);
      const { opened, index } = await loadIndex();
      state.index = index;
      const target = kindById.get(kindId);
      const json = await opened.readJson(`${format.folder}/${target.folder}/${id}.json`);
      if (!json) throw new Error(`${id} not found in ${state.source}`);
      state.doc = { kind: kindId, ...target.fromFile(json) };
      state.selected = -1;
      changed();
      setStatus(`Opened ${id} from ${state.source}`);
    }),

    problems: () => kind().validate(state.doc),
    exportJson: toFileJson,
    fileName: () => `${format.folder}/${kind().folder}/${state.doc.id || 'unnamed'}.json`,

    save: guard(async () => {
      const problems = kind().validate(state.doc);
      if (problems.length) throw new Error(problems.join('; '));
      if (!token()) throw new Error('Add a GitHub token first');
      const branch = branchNameFor(getPlayerName());
      const { folder, indexKey } = kind();
      const path = `${format.folder}/${folder}/${state.doc.id}.json`;
      const indexPath = `${format.folder}/index.json`;
      setStatus(`Saving to branch ${branch}…`);
      const result = await commitFiles({
        token: token(),
        upstream: SCENARIOS_REPO,
        branch,
        message: `${kind().label} ${state.doc.id}: ${state.doc.name}`,
        async buildFiles(readJson) {
          const index = (await readJson(indexPath)) ?? {};
          const ids = new Set(index[indexKey] ?? []);
          ids.add(state.doc.id);
          const nextIndex = { ...index, format: SCENARIO_FORMAT, [indexKey]: [...ids].sort() };
          return [
            { path, content: toFileJson() },
            { path: indexPath, content: `${JSON.stringify(nextIndex, null, 2)}\n` },
          ];
        },
      });
      editor.setSource(formatSource({ owner: result.owner, repo: result.repo, ref: result.branch }));
      ({ index: state.index } = await loadIndex());
      setStatus(`Saved. Play it from source ${state.source}`);
    }),

    /** Per frame: markers for the current file's points. */
    update() {
      const now = performance.now();
      const entries = [];
      state.doc.items.forEach((item, i) => {
        const def = format.pointTypes[item.type];
        if (!def) return;
        const { x, z } = viewFrame.fromLatLon(item.lat, item.lon);
        const y = terrain.surfaceHeightAt(x, z);
        if (y == null) return;
        let dir = roadDirs.get(item);
        if (def.gate && (!dir || (dir.failedAt != null && now - dir.failedAt > DIR_RETRY_MS))) {
          const snap = snapToRoad(streets, x, z, EDITOR_SNAP_RADIUS_M);
          dir = snap ? { dirX: snap.dirX, dirZ: snap.dirZ } : { failedAt: now };
          roadDirs.set(item, dir);
        }
        entries.push({
          key: item,
          gate: !!def.gate,
          width: item.width ?? 0,
          color: def.color,
          label: `${i + 1} ${def.short}`,
          selected: i === state.selected,
          x,
          y,
          z,
          dirX: dir?.dirX ?? 0,
          dirZ: dir?.dirZ ?? 0,
        });
      });
      markers.sync(entries);
    },
  };
  return editor;
}
