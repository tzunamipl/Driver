// Scenario editor session (a game mode's Editor button): free driving plus placing the
// mode's points at the car, snapped across the nearest road. Mode-specific parts come
// from its format (lib/scenarios/formats.js); the panel is ui/editorPanel.js. The draft
// lives in the editor's save slot; Save commits it to the player's branch on GitHub.

import {
  SCENARIOS_REPO,
  OFFICIAL_SCENARIO_SOURCE,
  SCENARIO_FORMAT,
  EDITOR_SOURCE_STORAGE_KEY,
  EDITOR_SNAP_RADIUS_M,
} from '../config.js';
import { readSaveField, writeSaveField } from '../lib/saves.js';
import { parseSource, formatSource, openSource } from '../lib/scenarios/source.js';
import { commitFiles, branchNameFor, readToken } from '../lib/scenarios/github.js';
import { snapToRoad } from '../lib/scenarios/roadSnap.js';
import { createGateMarkers } from '../lib/scenarios/gateMarkers.js';
import { fileKey, filePath, indexPath, splitKey } from '../lib/scenarios/paths.js';

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

  // A new file keeps the folder of the one before it: authors work a region at a time.
  const emptyDoc = (kind, { country = '', region = '' } = {}) => ({ kind, country, region, id: '', name: '', items: [] });
  const draft = readSaveField('editorDraft');
  const state = {
    doc: kindById.has(draft?.kind) && Array.isArray(draft.items) ? { country: '', region: '', ...draft } : emptyDoc(format.kinds[0].id),
    selected: -1,
    source: readStored(EDITOR_SOURCE_STORAGE_KEY) ?? OFFICIAL_SCENARIO_SOURCE,
    index: null, // the source's index.json: { [indexKey]: file keys }
    status: { text: '', error: false },
    busy: false,
  };
  // item -> { dirX, dirZ } or { failedAt }: road direction for its marker.
  const roadDirs = new WeakMap();

  const kind = () => kindById.get(state.doc.kind);
  const token = readToken;

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
    return { lat, lon, snapped: !!snap };
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
    const index = (await opened.readJson(indexPath(format.folder))) ?? {};
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
    getToken: token,

    newDoc(kindId) {
      if (state.doc.items.length && !window.confirm('Start a new file? Unsaved points will be lost.')) return;
      state.doc = emptyDoc(kindId, state.doc);
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
      if (def.gate) item.width = format.defaultGateWidth(type);
      else item.name = '';
      insertItem(item);
      state.status = def.gate && !point.snapped ? { text: 'No road nearby: placed at the car', error: true } : { text: '', error: false };
      changed();
    },
    addRef(key) {
      if (!key) return;
      insertItem({ type: 'ref', ref: key, name: '' });
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
    /** A file picked in the scenario tree; its source becomes the one stages are added from. */
    openPicked: guard(async ({ source, opened, kindId, key, json }) => {
      if (state.doc.items.length && !window.confirm(`Open ${key}? Unsaved points will be lost.`)) return;
      editor.setSource(formatSource(source));
      state.index = (await opened.readJson(indexPath(format.folder))) ?? {};
      // The file's folder is where it's saved back to.
      state.doc = { kind: kindId, ...kindById.get(kindId).fromFile(json), ...splitKey(key) };
      state.selected = -1;
      changed();
      setStatus(`Opened ${key} from ${state.source}`);
    }),

    problems: () => kind().validate(state.doc),
    exportJson: toFileJson,
    fileName: () => filePath(format.folder, kind(), fileKey({ ...state.doc, id: state.doc.id || 'unnamed' })),

    save: guard(async () => {
      const problems = kind().validate(state.doc);
      if (problems.length) throw new Error(problems.join('; '));
      if (!token()) throw new Error('Saving needs a GitHub token: add it in Settings → GitHub');
      const branch = branchNameFor(getPlayerName());
      const { indexKey } = kind();
      const key = fileKey(state.doc);
      const path = filePath(format.folder, kind(), key);
      const index = indexPath(format.folder);
      setStatus(`Saving to branch ${branch}…`);
      const result = await commitFiles({
        token: token(),
        upstream: SCENARIOS_REPO,
        branch,
        message: `${kind().label} ${key}: ${state.doc.name}`,
        async buildFiles(readJson) {
          const current = (await readJson(index)) ?? {};
          const keys = new Set(current[indexKey] ?? []);
          keys.add(key);
          const nextIndex = { ...current, format: SCENARIO_FORMAT, [indexKey]: [...keys].sort() };
          return [
            { path, content: toFileJson() },
            { path: index, content: `${JSON.stringify(nextIndex, null, 2)}\n` },
          ];
        },
      });
      editor.setSource(formatSource({ owner: result.owner, repo: result.repo, ref: result.branch }));
      ({ index: state.index } = await loadIndex());
      setStatus(result.unchanged ? 'No changes to save' : `Saved. Play it from source ${state.source}`);
    }),

    /** The file's placed points for the minimap, numbered like their 3D markers. */
    mapPoints() {
      const points = [];
      state.doc.items.forEach((item, i) => {
        const def = format.pointTypes[item.type];
        if (!def || item.lat == null) return;
        points.push({ lat: item.lat, lon: item.lon, color: def.color, label: String(i + 1), gate: !!def.gate, selected: i === state.selected });
      });
      return points;
    },

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
