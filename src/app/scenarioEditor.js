// Scenario editor session (a game mode's Editor button): free driving plus placing the
// mode's points at the car. Each gate snaps across the nearest road and faces along it unless
// unticked per point (then exactly where placed / turned by hand). Mode-specific parts come
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
import { snapToRoad, controlFrame, dirToHeading } from '../lib/scenarios/roadSnap.js';
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
  // item -> { signature, dirX, dirZ, boards } or { signature, failedAt }: travel direction and
  // roadside board spots (lat/lon, so origin shifts don't move them) for its markers.
  const frames = new WeakMap();

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

  /**
   * Point fields for the car's position. Gates go onto the nearest road (`snap`) and take the
   * car's heading when turned by hand (`manual`); with no road nearby, both fall back to the car.
   */
  function pointAtCar(type, { snap = true, manual = false } = {}) {
    const body = carManager.getVehicle()?.chassisBody;
    if (!body) return null;
    const { position: pos, quaternion: q } = body;
    if (!format.pointTypes[type].gate) return { ...viewFrame.toLatLon(pos.x, pos.z), snap: true, heading: null, roadless: false };
    // Chassis forward (local +z) in world space.
    const fx = 2 * (q.x * q.z + q.w * q.y);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const carHeading = format.normalHeading(dirToHeading(fx, fz));
    const road = snapToRoad(streets, pos.x, pos.z, EDITOR_SNAP_RADIUS_M);
    if (!road) return { ...viewFrame.toLatLon(pos.x, pos.z), snap: false, heading: carHeading, roadless: true };
    const at = snap ? road : pos;
    return { ...viewFrame.toLatLon(at.x, at.z), snap, heading: manual ? carHeading : null, roadless: false };
  }

  /** Moves a gate to `point`, taking its snap and heading. */
  function putAt(item, point) {
    Object.assign(item, { lat: point.lat, lon: point.lon });
    if (point.heading != null) item.heading = point.heading;
    else delete item.heading;
    if (point.snap) delete item.snap;
    else item.snap = false;
  }

  const roadlessStatus = (point) =>
    point.roadless ? { text: 'No road nearby: placed at the car, facing its way (snap and road orientation off)', error: true } : { text: '', error: false };

  const isPoint = (item) => !!format.pointTypes[item?.type];

  /** Item i's travel direction and board spots, as the game will place them; null while its road isn't loaded. */
  function resolveFrame(i, x, z) {
    const { items } = state.doc;
    const item = items[i];
    const neighbour = (j) => (isPoint(items[j]) ? viewFrame.fromLatLon(items[j].lat, items[j].lon) : null);
    const frame = controlFrame(streets, x, z, item, neighbour(i - 1), neighbour(i + 1), EDITOR_SNAP_RADIUS_M);
    if (!frame) return null;
    const half = (frame.roadWidth ?? item.width ?? 0) / 2;
    const boards = [];
    for (const { color, along, facing } of format.satellites?.(item.type) ?? []) {
      if (along === 0) continue; // the gate marker stands there
      const p = frame.walk(along);
      for (const s of [-1, 1]) {
        boards.push({ ...viewFrame.toLatLon(p.x - p.dirZ * half * s, p.z + p.dirX * half * s), color, dirX: p.dirX * facing, dirZ: p.dirZ * facing });
      }
    }
    return { ...viewFrame.toLatLon(frame.x, frame.z), dirX: frame.dirX, dirZ: frame.dirZ, boards };
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
          state.selected = existing;
          return changed();
        }
      }
      const item = { type, lat: point.lat, lon: point.lon };
      if (def.gate) {
        item.width = format.defaultGateWidth(type);
        putAt(item, point);
      } else item.name = '';
      insertItem(item);
      state.status = roadlessStatus(point);
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
      const point = pointAtCar(item.type, { snap: item.snap !== false, manual: Number.isFinite(item.heading) });
      if (!point) return;
      if (format.pointTypes[item.type].gate) putAt(item, point);
      else Object.assign(item, { lat: point.lat, lon: point.lon });
      state.status = roadlessStatus(point);
      changed();
    },
    /** Selected gate: on = across the nearest road's centreline, off = exactly at its lat/lon. */
    setSnap(on) {
      const item = state.doc.items[state.selected];
      if (!format.pointTypes[item?.type]?.gate) return;
      if (on) delete item.snap;
      else item.snap = false;
      changed();
    },
    /** Selected gate: on = faces along the road, off = keeps the direction it shows now, then turned by hand. */
    setRoadOrientation(on) {
      editor.setHeading(on ? null : editor.headingOf(state.selected) ?? 0);
    },
    /** Turns the selected gate to `degrees` (compass, direction of travel); null = follow the road again. */
    setHeading(degrees) {
      const item = state.doc.items[state.selected];
      if (!format.pointTypes[item?.type]?.gate) return;
      if (degrees == null) delete item.heading;
      else item.heading = format.normalHeading(degrees);
      changed();
    },
    /** Item i's travel direction in compass degrees: its own heading, else the road's once known. */
    headingOf(i) {
      const item = state.doc.items[i];
      if (Number.isFinite(item?.heading)) return item.heading;
      const frame = item && frames.get(item);
      return frame?.dirX != null ? dirToHeading(frame.dirX, frame.dirZ) : null;
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

    /** Per frame: markers for the current file's points and their roadside boards. */
    update() {
      const now = performance.now();
      const { items } = state.doc;
      const entries = [];
      let selectedResolved = false;
      items.forEach((item, i) => {
        const def = format.pointTypes[item.type];
        if (!def) return;
        let { x, z } = viewFrame.fromLatLon(item.lat, item.lon);
        let dir = frames.get(item);
        if (def.gate) {
          // Facing depends on the neighbours: recomputed when any of them moves.
          const at = (it) => (isPoint(it) ? `${it.lat},${it.lon}` : '');
          const signature = `${at(item)},${item.heading},${item.snap}|${at(items[i - 1])}|${at(items[i + 1])}`;
          if (dir?.signature !== signature || (dir.failedAt != null && now - dir.failedAt > DIR_RETRY_MS)) {
            dir = { signature, ...(resolveFrame(i, x, z) ?? { failedAt: now }) };
            frames.set(item, dir);
            if (i === state.selected && dir.dirX != null) selectedResolved = true;
          }
          // Where the game will stand it: on the road when snapped.
          if (dir.lat != null) ({ x, z } = viewFrame.fromLatLon(dir.lat, dir.lon));
          dir.boards?.forEach((board, j) => {
            const p = viewFrame.fromLatLon(board.lat, board.lon);
            const by = terrain.surfaceHeightAt(p.x, p.z);
            if (by != null) entries.push({ key: `${i}:${j}`, board: true, color: board.color, x: p.x, y: by, z: p.z, dirX: board.dirX, dirZ: board.dirZ });
          });
        }
        const y = terrain.surfaceHeightAt(x, z);
        if (y == null) return;
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
      // The dial shows the road's direction once it's known.
      if (selectedResolved) changed({ save: false });
    },
  };
  return editor;
}
