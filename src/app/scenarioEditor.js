// Scenario editor session (a game mode's Editor button): free driving plus placing the
// mode's points at the car. Each gate snaps across the nearest road and faces along it unless
// unticked per point (then exactly where placed / turned by hand). Stages get generated,
// hand-corrected pacenotes (lib/rally/pacenotes.js) along its road route (drawn on the road and the maps,
// lib/rally/stageRouteLine.js, optionally the reverse run's too) and surface sections marked at the car along the stage
// road (lib/rally/surfaceSections.js), in force on the road while editing. A stage's reverse version
// (lib/rally/stageReverse.js) is edited by switching to it: the points in its driving order and roles, its own
// pacenotes, passage controls and objects in one version or both; surface sections are shared. Course objects (format `objectTypes`: bales,
// tapes, signs) go exactly at the car, facing its way. They and the points' zone props stand as in the game
// (lib/rally/controlScenery.js) but without collisions. Mode-specific parts come
// from its format (lib/scenarios/formats.js); the panels are ui/editorPanel.js, ui/courseObjectsPanel.js and ui/surfacePanel.js. The draft
// lives in the editor's save slot; Publish commits it to the player's branch (lib/scenarios/publish.js).

import {
  OFFICIAL_SCENARIO_SOURCE,
  SCENARIOS_REPO,
  EDITOR_PACENOTE_BOARDS_STORAGE_KEY,
  EDITOR_PACENOTES_BOTH_STORAGE_KEY,
  EDITOR_STAGE_ROUTE_STORAGE_KEY,
  EDITOR_REVERSE_ROUTE_STORAGE_KEY,
  EDITOR_SNAP_RADIUS_M,
} from '../config.js';
import { readSaveField, writeSaveField } from '../lib/saves.js';
import { parseSource, formatSource, openSource } from '../lib/scenarios/source.js';
import { publishScenario, publishEnabled, branchNameFor } from '../lib/scenarios/publish.js';
import { snapToRoad, controlFrame, dirToHeading } from '../lib/scenarios/roadSnap.js';
import { createGateMarkers } from '../lib/scenarios/gateMarkers.js';
import { createControlScenery } from '../lib/rally/controlScenery.js';
import { fileKey, filePath, indexPath, splitKey } from '../lib/scenarios/paths.js';
import { generatePacenotes, pacenoteAt, stageLine, spotOnLine, withSurfaceNotes, reverseSections } from '../lib/rally/pacenotes.js';
import { encodeRoute, routeKey, savedRouteFor } from '../lib/rally/savedRoute.js';
import { noteLabel, gapLabel } from '../lib/rally/pacenoteCalls.js';
import { placeSection } from '../lib/rally/surfaceSections.js';
import { STAGE_SURFACES } from '../lib/rally/stageSurfaces.js';
import { createStageRouteLine, REVERSE_ROUTE_COLOR } from '../lib/rally/stageRouteLine.js';
import { drivenStagePoints, drivenOrder, drivenType, inVersion, reversePoint } from '../lib/rally/stageReverse.js';
import { lon2tileX, lat2tileY } from '../lib/geo.js';
import { longDistanceValue, longDistanceUnit } from '../lib/units.js';

// Points without a known road direction retry the snap this often (streets still loading).
const DIR_RETRY_MS = 1000;
const NOTE_MARKER_M = 300; // pacenote markers within this of the car
const NOTE_COLOR = 0xffffff; // minimap dot
const OBJECT_LABEL_M = 150; // course object labels within this of the car
const SECTION_SNAP_M = 30; // a section end (the car) this close to the stage road
const SECTION_COLOR = 0xff8c1a; // minimap dot of the selected section's start
const ROUTE_DELAY_MS = 800; // the stage is routed again this long after its points last changed
const REVERSE_LINE_OFFSET_M = 1; // the reverse line beside the forward one, right of its own travel

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
export function createScenarioEditor({ format, scene, world, terrain, streets, viewFrame, carManager, addressSearch, getPlayerName }) {
  const markers = createGateMarkers(scene);
  const routeLine = createStageRouteLine({ scene, terrain, viewFrame });
  const reverseLine = createStageRouteLine({ scene, terrain, viewFrame, color: REVERSE_ROUTE_COLOR, offsetM: REVERSE_LINE_OFFSET_M });
  // Zone props of the points and the course objects, as the game shows them but never in the way.
  const scenery = format.objectTypes ? createControlScenery({ scene, world, streets, terrain, viewFrame, editor: true }) : null;
  let sceneryDirty = true;
  let shownPoints = ''; // signature of the points the scenery shows
  const kindById = new Map(format.kinds.map((kind) => [kind.id, kind]));
  const listeners = new Set();

  // A new file keeps the folder of the one before it: authors work a region at a time.
  const emptyDoc = (kind, { country = '', region = '' } = {}) => ({ kind, country, region, id: '', name: '', items: [], objects: [], surfaces: [] });
  const draft = readSaveField('editorDraft');
  const state = {
    doc: kindById.has(draft?.kind) && Array.isArray(draft.items) ? { country: '', region: '', objects: [], surfaces: [], ...draft } : emptyDoc(format.kinds[0].id),
    reverse: false, // editing the stage's reverse version
    selected: -1,
    selectedObject: -1, // index into doc.objects
    selectedNote: -1, // index into doc.pacenotes.notes
    hoverNote: -1, // under the mouse in the world
    selectedSection: -1, // index into doc.surfaces
    sectionStart: null, // metres along the stage where the next section starts, once marked
    newSectionSurface: 'gravel', // stageSurfaces.js id the next section gets
    showNoteBoards: readStored(EDITOR_PACENOTE_BOARDS_STORAGE_KEY) !== '0',
    generateBoth: readStored(EDITOR_PACENOTES_BOTH_STORAGE_KEY) === '1', // Generate does the forward and reverse versions
    showRoute: readStored(EDITOR_STAGE_ROUTE_STORAGE_KEY) !== '0',
    showReverseRoute: readStored(EDITOR_REVERSE_ROUTE_STORAGE_KEY) === '1',
    route: { text: '', error: false }, // the drawn stage route: its length, or why there's none
    reverseRoute: { text: '', error: false }, // the same for the reverse run
    source: OFFICIAL_SCENARIO_SOURCE, // where `index` comes from: the branch Publish goes to, else official
    index: null, // the source's index.json: { [indexKey]: file keys }
    refNames: {}, // stage key -> its name in `source` (null while loading)
    status: { text: '', error: false },
    busy: false,
  };
  // item -> { signature, dirX, dirZ, boards } or { signature, failedAt }: travel direction and
  // roadside board spots (lat/lon, so origin shifts don't move them) for its markers.
  const frames = new WeakMap();

  const kind = () => kindById.get(state.doc.kind);

  let shownSurfaces = ''; // signature of the sections the road has
  function syncSurfaces() {
    const surfaces = state.doc.surfaces ?? [];
    const signature = JSON.stringify(surfaces);
    if (signature === shownSurfaces) return;
    shownSurfaces = signature;
    streets.setSurfaceSections(surfaces);
  }

  let editedAt = 0;
  function changed({ save = true } = {}) {
    if (save) {
      editedAt = performance.now();
      writeSaveField('editorDraft', state.doc);
      sceneryDirty = true;
      syncSurfaces();
    }
    for (const listener of listeners) listener(state);
  }

  const reversed = () => state.reverse && state.doc.kind === 'stage';
  /** The doc's points as driven in a version (a stage's; a rally's as they are). */
  const drivenPoints = (reverse) =>
    state.doc.kind === 'stage' ? drivenStagePoints(state.doc.items, { reverse, defaultWidth: format.defaultGateWidth }) : state.doc.items;
  const notesKey = (reverse = reversed()) => (reverse ? 'reversePacenotes' : 'pacenotes');
  /** The edited version's pacenotes, or null. */
  const editedNotes = () => state.doc[notesKey()] ?? null;

  const routeField = (reverse) => (reverse ? 'reverseRoute' : 'route');
  /** The doc's saved route of a version if still routed through its points, else null. */
  const freshRoute = (reverse) => (state.doc.kind === 'stage' ? savedRouteFor(state.doc[routeField(reverse)], drivenPoints(reverse)) : null);

  // Each version's stage line of the last points it was routed for (routing again is slow, the tiles are cached anyway).
  const lines = new Map(); // reverse -> { key, promise, what }
  const lineKey = () =>
    JSON.stringify(state.doc.items.map(({ type, lat, lon, straight, straightReverse, only }) => [type, lat, lon, !!straight, !!straightReverse, only ?? null]));
  /** `reverse`: the reverse version's (needs its start and finish); `what`: names the action in the status while roads are fetched, null = a route line's own routing. */
  function lineFor(reverse, what) {
    const key = lineKey();
    let line = lines.get(reverse);
    if (line?.key !== key) {
      if (what) setStatus(`${what}: fetching roads…`);
      const progress = (done, total) => {
        const current = lines.get(reverse);
        if (current?.key !== key) return;
        if (current.what) setStatus(`${current.what}: fetching roads ${done}/${total}…`);
        else if (reverse) setReverseRoute(`Reverse route: fetching roads ${done}/${total}…`);
        else setRoute(`Route: fetching roads ${done}/${total}…`);
      };
      // Forward partial without a finish: s is from the start either way, so sections marked meanwhile still fit.
      const points = drivenPoints(reverse);
      line = { key, what, promise: stageLine(points, progress, { partial: !reverse }) };
      lines.set(reverse, line);
      const pending = line;
      // A whole start-to-finish line is also the file's saved route for that version.
      const savedKey = routeKey(points);
      line.promise.then(
        (stage) => {
          if (savedKey && lines.get(reverse) === pending && lineKey() === key) state.doc[routeField(reverse)] = encodeRoute(stage, savedKey);
        },
        () => {
          if (lines.get(reverse) === pending) lines.delete(reverse);
        }
      );
    }
    if (what) line.what = what;
    return line.promise;
  }

  /** Surface sections as met in a version, for its surface calls along its `line`. */
  const sectionsFor = (reverse, line) => (reverse ? reverseSections(state.doc.surfaces ?? [], Math.round(line.samples.length)) : state.doc.surfaces ?? []);

  function setRoute(text, error = false) {
    state.route = { text, error };
    changed({ save: false });
  }

  function setReverseRoute(text, error = false) {
    state.reverseRoute = { text, error };
    changed({ save: false });
  }

  /** A stage line as { mx, my } normalised Web Mercator, for the maps. */
  function toMapRoute(stage) {
    const n = stage.samples.x.length;
    const out = { mx: new Float64Array(n), my: new Float64Array(n) };
    for (let i = 0; i < n; i++) {
      const { lat, lon } = stage.routePoint(i);
      out.mx[i] = lon2tileX(lon, 0);
      out.my[i] = lat2tileY(lat, 0);
    }
    return out;
  }

  // The drawn route: stage files from the start to the finish, or the last route point while there's none; routed again once their points settle.
  let routedKey = null;
  let mapRoute = null;
  function showRouteOf(stage) {
    routeLine.set(stage);
    mapRoute = stage ? toMapRoute(stage) : null;
  }

  // The reverse run's route (finish to start, straight legs turned round with it): needs both ends.
  let reverseRoutedKey = null;
  let reverseMapRoute = null;
  function showReverseOf(stage) {
    reverseLine.set(stage);
    reverseMapRoute = stage ? toMapRoute(stage) : null;
  }
  function syncReverseRoute(now) {
    const key = state.showReverseRoute && state.doc.kind === 'stage' ? lineKey() : null;
    if (key === reverseRoutedKey || (key && now - editedAt < ROUTE_DELAY_MS)) return;
    reverseRoutedKey = key;
    const types = state.doc.items.map((item) => item.type);
    if (!key || !types.includes('start') || !types.includes('finish')) {
      showReverseOf(null);
      return setReverseRoute(key ? 'Reverse route: place the start and the finish' : '');
    }
    lineFor(true, null).then(
      (stage) => {
        if (reverseRoutedKey !== key) return;
        showReverseOf(stage);
        setReverseRoute(`Reverse route: ${longDistanceValue(((stage.samples.x.length - 1) * stage.step) / 1000).toFixed(2)} ${longDistanceUnit()}, finish to start`);
      },
      (err) => {
        if (reverseRoutedKey !== key) return;
        showReverseOf(null);
        setReverseRoute(`Reverse route: ${err.message}`, true);
      }
    );
  }
  function syncRoute(now) {
    const key = state.showRoute && state.doc.kind === 'stage' ? lineKey() : null;
    if (key === routedKey || (key && now - editedAt < ROUTE_DELAY_MS)) return;
    routedKey = key;
    if (!key || !state.doc.items.some((item) => item.type === 'start')) {
      showRouteOf(null);
      return setRoute(key ? 'Route: place the start' : '');
    }
    lineFor(false, null).then(
      (stage) => {
        if (routedKey !== key) return;
        showRouteOf(stage);
        const to = state.doc.items.some((item) => item.type === 'finish') ? 'finish' : 'last point (no finish yet)';
        setRoute(`Route: ${longDistanceValue(((stage.samples.x.length - 1) * stage.step) / 1000).toFixed(2)} ${longDistanceUnit()}, start to ${to}`);
      },
      (err) => {
        if (routedKey !== key) return;
        showRouteOf(null);
        setRoute(`Route: ${err.message}`, true);
      }
    );
  }

  /** Metres along the stage line where the car is; throws off the stage road. */
  function carSpot(stage) {
    const pos = carManager.getVehicle()?.chassisBody.position;
    if (!pos) throw new Error('No car');
    const { lat, lon } = viewFrame.toLatLon(pos.x, pos.z);
    const { s, dist } = spotOnLine(stage, lat, lon);
    if (dist > SECTION_SNAP_M) throw new Error(`Drive onto the stage road first (${Math.round(dist)} m off it)`);
    return s;
  }

  /** Sections changed (`stage`: the forward line): both versions' pacenotes' surface calls follow them. */
  async function sectionsChanged(stage) {
    const { pacenotes, reversePacenotes } = state.doc;
    if (pacenotes?.notes.length) state.doc.pacenotes = withSurfaceNotes(pacenotes, stage, sectionsFor(false, stage));
    if (reversePacenotes?.notes.length) {
      const line = await lineFor(true, 'Section');
      state.doc.reversePacenotes = withSurfaceNotes(reversePacenotes, line, sectionsFor(true, line));
    }
    if (pacenotes?.notes.length || reversePacenotes?.notes.length) state.selectedNote = -1;
    changed();
  }

  function setStatus(text, error = false) {
    state.status = { text, error };
    changed({ save: false });
  }

  /** Compass heading the chassis (quaternion `q`) faces: its local +z in world space. */
  const facing = (q) => format.normalHeading(dirToHeading(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y)));

  /**
   * Point fields for the car's position. Gates go onto the nearest road (`snap`) and take the
   * car's heading when turned by hand (`manual`); with no road nearby, both fall back to the car.
   */
  function pointAtCar(type, { snap = true, manual = false } = {}) {
    const body = carManager.getVehicle()?.chassisBody;
    if (!body) return null;
    const { position: pos, quaternion: q } = body;
    if (!format.pointTypes[type].gate) return { ...viewFrame.toLatLon(pos.x, pos.z), snap: true, heading: null, roadless: false };
    const carHeading = facing(q);
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

  /** A point at the car with its heading as the file keeps it (the reverse version drives the other way). */
  const asStored = (point) => (reversed() && point.heading != null ? { ...point, heading: format.normalHeading(point.heading + 180) } : point);

  const roadlessStatus = (point) =>
    point.roadless ? { text: 'No road nearby: placed at the car, facing its way (snap and road orientation off)', error: true } : { text: '', error: false };

  const isPoint = (item) => !!format.pointTypes[item?.type];
  const isPointRef = (item) => item?.type === 'pointRef';
  /** The point an item stands for: itself, or the gate a repeat drives again; null for stages / unknown IDs. */
  const pointOf = (item) => (isPointRef(item) ? state.doc.items.find((it) => it.id === item.ref && isPoint(it)) ?? null : isPoint(item) ? item : null);
  /** 1-based list positions of an item's repeats. */
  const repeatNumbers = (item) => (item.id ? state.doc.items.flatMap((it, j) => (isPointRef(it) && it.ref === item.id ? [j + 1] : [])) : []);

  /** A free point ID from the type's short label, e.g. 'sp-in', then 'sp-in-2'. */
  function freePointId(type) {
    const base = format.pointTypes[type].short.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'point';
    const taken = new Set(state.doc.items.map((it) => it.id).filter(Boolean));
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
  }

  /**
   * The list as edited: every item in the edited version's driving order (a stage's reverse: the file's backwards),
   * `point` = the item as driven there (reverse role and heading), `driven` = in that version.
   */
  function listItems() {
    const { items } = state.doc;
    const reverse = reversed();
    const order = items.map((_, i) => i);
    if (reverse) order.reverse();
    return order.map((index) => {
      const item = items[index];
      const point = reverse && isPoint(item) ? reversePoint(item, { defaultWidth: format.defaultGateWidth }) : item;
      return { index, item, point, driven: inVersion(item, reverse) };
    });
  }

  // item -> as `frames`, for the reverse version.
  const reverseFrames = new WeakMap();

  /** Entry k of `view` (driven listItems()): its travel direction and board spots, as the game will place them; null while its road isn't loaded. */
  function resolveFrame(view, k, x, z) {
    const { point } = view[k];
    const neighbour = (j) => {
      const p = view[j] && pointOf(view[j].item);
      return p ? viewFrame.fromLatLon(p.lat, p.lon) : null;
    };
    const frame = controlFrame(streets, x, z, point, neighbour(k - 1), neighbour(k + 1), EDITOR_SNAP_RADIUS_M);
    if (!frame) return null;
    const half = (frame.roadWidth ?? point.width ?? 0) / 2;
    const boards = [];
    for (const { color, along, facing } of format.satellites?.(point.type) ?? []) {
      if (along === 0) continue; // the gate marker stands there
      const p = frame.walk(along);
      for (const s of [-1, 1]) {
        boards.push({ ...viewFrame.toLatLon(p.x - p.dirZ * half * s, p.z + p.dirX * half * s), color, dirX: p.dirX * facing, dirZ: p.dirZ * facing });
      }
    }
    return { ...viewFrame.toLatLon(frame.x, frame.z), dirX: frame.dirX, dirZ: frame.dirZ, boards };
  }

  /** The file's gates (repeats included, driving order of the edited version), base and objects into the scenery; points only rebuilt when they changed. */
  function syncScenery() {
    const reverse = reversed();
    const points = (state.doc.kind === 'stage' ? drivenPoints(reverse) : state.doc.items.map(pointOf)).filter((point) => format.pointTypes[point?.type]?.gate);
    const base = state.doc.items.find((item) => item.type === 'base') ?? null;
    const signature = JSON.stringify([points, base?.lat, base?.lon]);
    if (signature !== shownPoints) {
      shownPoints = signature;
      scenery.setPoints(points);
      scenery.setBase(base);
    }
    scenery.setObjects(state.doc.objects.filter((object) => inVersion(object, reverse)), { keepState: true });
  }

  function insertItem(item) {
    // Reverse: after the selection in its driving order = before it in the file.
    const at = reversed() ? Math.max(state.selected, 0) : state.selected >= 0 ? state.selected + 1 : state.doc.items.length;
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

  let opened = null; // the commit `state.index` was read from

  async function useIndexOf(source) {
    opened = source;
    state.source = formatSource(source.source);
    state.refNames = {};
    state.index = (await source.readJson(indexPath(format.folder))) ?? {};
  }

  // Stages are listed from the branch Publish commits to (the worker makes it from official when
  // missing): rally stage keys then resolve on that branch, and on official once it's merged.
  async function loadIndex() {
    try {
      await useIndexOf(await openSource({ ...SCENARIOS_REPO, ref: branchNameFor(getPlayerName()) }));
    } catch (err) {
      if (!err.notFound) throw err;
      await useIndexOf(await openSource(parseSource(OFFICIAL_SCENARIO_SOURCE)));
    }
  }

  function toFileJson() {
    const doc = state.doc.kind === 'stage' ? { ...state.doc, route: freshRoute(false), reverseRoute: freshRoute(true) } : state.doc;
    return `${JSON.stringify(kind().toFile(doc), null, 2)}\n`;
  }

  /** Routes and saves each version's route not saved for the stage's current points; one that can't be routed isn't saved. */
  async function refreshRoutes() {
    if (state.doc.kind !== 'stage') return;
    for (const reverse of [false, true]) {
      const key = routeKey(drivenPoints(reverse));
      if (!key || freshRoute(reverse)) continue;
      const stage = await lineFor(reverse, reverse ? 'Reverse route' : 'Route').catch(() => null);
      if (stage) state.doc[routeField(reverse)] = encodeRoute(stage, key);
    }
  }

  const editor = {
    format,
    state,
    kind,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
    },

    newDoc(kindId) {
      if ((state.doc.items.length || state.doc.objects.length) && !window.confirm('Start a new file? Unsaved points will be lost.')) return;
      state.doc = emptyDoc(kindId, state.doc);
      state.selected = -1;
      state.selectedNote = -1;
      state.selectedSection = -1;
      state.sectionStart = null;
      state.selectedObject = -1;
      state.status = { text: '', error: false };
      changed();
    },
    setMeta(field, value) {
      state.doc[field] = value;
      changed();
    },

    /** `type` as driven in the edited version (the reverse's start is kept as the file's finish). */
    place(drivenAs) {
      const type = drivenType(drivenAs, reversed());
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
        putAt(item, asStored(point));
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
    /** Whether a referenced file is on the listed branch; true until the index loads. */
    refListed(key) {
      const refKind = kind().refKind && kindById.get(kind().refKind);
      return !refKind || !state.index || (state.index[refKind.indexKey] ?? []).includes(key);
    },
    /** Fetches the names of the referenced-kind files `keys` not asked for yet (into state.refNames). */
    loadRefNames(keys) {
      const refKind = kindById.get(kind().refKind);
      const from = opened;
      for (const key of keys) {
        if (key in state.refNames) continue;
        state.refNames[key] = null;
        from.readJson(filePath(format.folder, refKind, key)).then(
          (json) => {
            if (from !== opened || !json?.name) return;
            state.refNames[key] = json.name;
            changed({ save: false });
          },
          () => {}
        );
      }
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
    /** Selected stage reference: on = that pass drives the stage the other way. */
    setRefReverse(on) {
      const item = state.doc.items[state.selected];
      if (item?.type !== 'ref') return;
      if (on) item.reverse = true;
      else delete item.reverse;
      changed();
    },
    moveSelectedToCar() {
      const item = state.doc.items[state.selected];
      if (!isPoint(item)) return;
      const point = pointAtCar(item.type, { snap: item.snap !== false, manual: Number.isFinite(item.heading) });
      if (!point) return;
      if (format.pointTypes[item.type].gate) putAt(item, asStored(point));
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
    /** Selected route point: on = the edited version's route reaches it in a straight line from the point before, ignoring roads. */
    setStraight(on) {
      const item = state.doc.items[state.selected];
      const reverse = reversed();
      if (!item || !format.pointTypes[drivenType(item.type, reverse)]?.routed) return;
      const field = reverse ? 'straightReverse' : 'straight';
      if (on) item[field] = true;
      else delete item[field];
      changed();
    },
    /** Item i's straight leg in the edited version: { on, fromForward } (a reverse leg straight because the forward one is: set there). */
    straightOf(i) {
      const item = state.doc.items[i];
      if (!reversed()) return { on: !!item?.straight, fromForward: false };
      const k = drivenOrder(state.doc.items, true).indexOf(i);
      if (k < 0) return { on: !!item?.straightReverse, fromForward: false };
      const fromForward = !!drivenStagePoints(state.doc.items, { reverse: true, ownReverseFlags: false })[k].straight;
      return { on: fromForward || !!item.straightReverse, fromForward };
    },
    /** Selected point with stage versions: 'forward' | 'reverse' = in that version only, null = both. */
    setOnly(value) {
      const item = state.doc.items[state.selected];
      if (!format.pointTypes[item?.type]?.versions) return;
      if (value) item.only = value;
      else delete item.only;
      changed();
    },
    /** Stage: edit its reverse version (points in its driving order and roles, its pacenotes, its objects shown) or the forward one. */
    setReverse(on) {
      state.reverse = on;
      state.selectedNote = -1;
      state.hoverNote = -1;
      state.sectionStart = null;
      sceneryDirty = true;
      changed({ save: false });
    },
    listItems,
    notes: editedNotes,
    /** Selected gate: on = faces along the road, off = keeps the direction it shows now, then turned by hand. */
    setRoadOrientation(on) {
      editor.setHeading(on ? null : editor.headingOf(state.selected) ?? 0);
    },
    /** Turns the selected gate to `degrees` (compass, direction of travel); null = follow the road again. */
    setHeading(degrees) {
      const item = state.doc.items[state.selected];
      if (!format.pointTypes[item?.type]?.gate) return;
      if (degrees == null) delete item.heading;
      else item.heading = format.normalHeading(reversed() ? degrees + 180 : degrees);
      changed();
    },
    /** Item i's travel direction in compass degrees in the edited version: its own heading, else the road's once known. */
    headingOf(i) {
      const item = state.doc.items[i];
      if (Number.isFinite(item?.heading)) return reversed() ? format.normalHeading(item.heading + 180) : item.heading;
      const frame = item && (reversed() ? reverseFrames : frames).get(item);
      return frame?.dirX != null ? dirToHeading(frame.dirX, frame.dirZ) : null;
    },
    shiftSelected(delta) {
      const { items } = state.doc;
      if (reversed()) delta = -delta; // earlier in the reverse = later in the file
      const to = state.selected + delta;
      if (state.selected < 0 || to < 0 || to >= items.length) return;
      [items[state.selected], items[to]] = [items[to], items[state.selected]];
      state.selected = to;
      changed();
    },
    deleteSelected() {
      const item = state.doc.items[state.selected];
      if (!item) return;
      // Repeats of a deleted gate would point at nothing.
      const repeats = item.id ? state.doc.items.filter((it) => isPointRef(it) && it.ref === item.id) : [];
      if (repeats.length && !window.confirm(`Delete this point and its ${repeats.length} repeat${repeats.length === 1 ? '' : 's'}?`)) return;
      state.doc.items = state.doc.items.filter((it) => it !== item && !repeats.includes(it));
      state.selected = Math.min(state.selected, state.doc.items.length - 1);
      changed();
    },
    /** The selected gate (or the one a selected repeat drives) again, right after the selection; gives it an ID if it has none. */
    repeatSelected() {
      const target = pointOf(state.doc.items[state.selected]);
      if (!kind().pointRefs || !format.pointTypes[target?.type]?.gate) return;
      target.id ||= freePointId(target.type);
      insertItem({ type: 'pointRef', ref: target.id });
      changed();
    },
    /** Renames the selected gate's ID, its repeats along; refused when taken, or when cleared while repeated. */
    setPointId(value) {
      const item = state.doc.items[state.selected];
      if (!format.pointTypes[item?.type]?.gate) return;
      const repeats = item.id ? state.doc.items.filter((it) => isPointRef(it) && it.ref === item.id) : [];
      if (value && state.doc.items.some((it) => it !== item && it.id === value)) return setStatus(`Point ID "${value}" is already used`, true);
      if (!value && repeats.length) return setStatus('A repeated point needs an ID', true);
      if (value) item.id = value;
      else delete item.id;
      for (const ref of repeats) ref.ref = value;
      state.status = { text: '', error: false };
      changed();
    },
    /** Selected repeat: selects the gate it drives again. */
    selectOriginal() {
      const target = pointOf(state.doc.items[state.selected]);
      if (target) editor.select(state.doc.items.indexOf(target));
    },
    /** The gate item i drives again (a repeat), or null. */
    repeatTarget: (i) => (isPointRef(state.doc.items[i]) ? pointOf(state.doc.items[i]) : null),
    repeatNumbers,
    goToSelected() {
      const item = pointOf(state.doc.items[state.selected]) ?? state.doc.items.find(isPoint);
      if (!item) return;
      addressSearch.teleport(item.lat, item.lon, format.pointTypes[item.type].label);
    },

    /** Stage: pacenotes from the start through splits / passage controls to the finish, over OSM roads. */
    /** Stage: the edited version's pacenotes, or both versions' with `generateBoth`. */
    generatePacenotes: guard(async () => {
      const versions = state.generateBoth ? [false, true] : [reversed()];
      if (versions.some((reverse) => state.doc[notesKey(reverse)]?.notes.length) && !window.confirm('Generate pacenotes again? Your edits to them will be lost.')) return;
      const done = [];
      for (const reverse of versions) {
        const what = reverse ? 'Reverse pacenotes' : 'Pacenotes';
        setStatus(`${what}: fetching roads…`);
        let pacenotes = await generatePacenotes(drivenPoints(reverse), {
          surfaces: reverse ? [] : state.doc.surfaces ?? [],
          onProgress: (n, total) => setStatus(`${what}: fetching roads ${n}/${total}…`),
        });
        if (reverse) {
          const line = await lineFor(true, what);
          pacenotes = withSurfaceNotes(pacenotes, line, sectionsFor(true, line));
        }
        state.doc[notesKey(reverse)] = pacenotes;
        done.push(`${pacenotes.notes.length}${versions.length > 1 ? (reverse ? ' reverse' : ' forward') : ''} pacenotes over ${(pacenotes.length / 1000).toFixed(1)} km`);
      }
      state.selectedNote = -1;
      changed();
      setStatus(`${done.join(', ')}. Move a point? Generate again.`);
    }),
    /** Stage: Generate does both versions (on) or only the edited one. */
    setGenerateBoth(on) {
      state.generateBoth = on;
      writeStored(EDITOR_PACENOTES_BOTH_STORAGE_KEY, on ? '1' : null);
      changed({ save: false });
    },
    /** Stage: one note where the car is, on the stage road, slotted in by distance and selected. */
    addNote: guard(async () => {
      const pos = carManager.getVehicle()?.chassisBody.position;
      if (!pos) return;
      const { lat, lon } = viewFrame.toLatLon(pos.x, pos.z);
      setStatus('Pacenote: fetching roads…');
      const reverse = reversed();
      const { length, note } = await pacenoteAt(drivenPoints(reverse), lat, lon, {
        onProgress: (done, total) => setStatus(`Pacenote: fetching roads ${done}/${total}…`),
      });
      state.doc[notesKey(reverse)] ??= { length, notes: [] };
      const { notes } = state.doc[notesKey(reverse)];
      const i = notes.findIndex((n) => n.s > note.s);
      state.selectedNote = i < 0 ? notes.length : i;
      notes.splice(state.selectedNote, 0, note);
      changed();
      setStatus(`Added ${noteLabel(note)} at ${note.s} m. Adjust it below.`);
    }),
    /** `toggle`: selecting the selected note again clears it (list clicks). */
    selectNote(i, toggle = true) {
      state.selectedNote = toggle && state.selectedNote === i ? -1 : i;
      changed({ save: false });
    },
    /** Pacenote tile hit by the ray, as an index, or -1. */
    pickNote(raycaster) {
      const note = markers.pick(raycaster);
      return note ? editedNotes()?.notes.indexOf(note) ?? -1 : -1;
    },
    setHoverNote(i) {
      state.hoverNote = i;
    },
    /** Stage route line on the road and the maps on / off. */
    setShowRoute(on) {
      state.showRoute = on;
      writeStored(EDITOR_STAGE_ROUTE_STORAGE_KEY, on ? null : '0');
      routeLine.setVisible(on);
      changed({ save: false });
    },
    /** The stage route for the maps ({ mx, my }), or null. */
    mapRoute: () => (state.showRoute && state.doc.kind === 'stage' ? mapRoute : null),
    /** The reverse run's route line on the road and the maps on / off. */
    setShowReverseRoute(on) {
      state.showReverseRoute = on;
      writeStored(EDITOR_REVERSE_ROUTE_STORAGE_KEY, on ? '1' : null);
      reverseLine.setVisible(on);
      changed({ save: false });
    },
    /** The reverse run's route for the maps ({ mx, my }), or null. */
    mapReverseRoute: () => (state.showReverseRoute && state.doc.kind === 'stage' ? reverseMapRoute : null),

    /** Pacenote boards on the road (and clicking them) on / off. */
    setShowNoteBoards(on) {
      state.showNoteBoards = on;
      writeStored(EDITOR_PACENOTE_BOARDS_STORAGE_KEY, on ? null : '0');
      if (!on) state.hoverNote = -1;
      changed({ save: false });
    },
    /** Selected note: dir ('L' | 'R' | 'S'), grade (1..6) or junction (boolean). */
    setNoteField(field, value) {
      const note = editedNotes()?.notes[state.selectedNote];
      if (!note) return;
      if (field === 'junction') {
        if (value) note.junction = true;
        else delete note.junction;
      } else note[field] = value;
      // Straight on is only a junction call; a corner needs a grade.
      if (note.dir === 'S') {
        delete note.grade;
        note.junction = true;
      } else note.grade ??= 6;
      changed();
    },
    deleteNote() {
      const notes = editedNotes()?.notes;
      if (!notes?.[state.selectedNote]) return;
      notes.splice(state.selectedNote, 1);
      state.selectedNote = Math.min(state.selectedNote, notes.length - 1);
      changed();
    },
    goToNote() {
      const note = editedNotes()?.notes[state.selectedNote];
      if (note) addressSearch.teleport(note.lat, note.lon, `Pacenote ${state.selectedNote + 1}`);
    },

    /** Stage: the surface (stageSurfaces.js id) the next section gets. */
    setNewSectionSurface(id) {
      state.newSectionSurface = id;
      changed({ save: false });
    },
    /** Stage: the next section starts where the car is on the stage road. */
    markSectionStart: guard(async () => {
      const stage = await lineFor(false, 'Section');
      state.sectionStart = carSpot(stage);
      setStatus(`Section starts at ${Math.round(state.sectionStart)} m. Drive to its end, then End at car.`);
    }),
    /** Stage: the section from the marked start to the car, laid over the others (it wins where they overlap); selected. */
    markSectionEnd: guard(async () => {
      if (state.sectionStart == null) throw new Error('Mark the start first');
      const stage = await lineFor(false, 'Section');
      const end = carSpot(stage);
      const from = Math.min(state.sectionStart, end);
      const to = Math.max(state.sectionStart, end);
      if (to - from < 5) throw new Error('Drive further along the stage road: the section is under 5 m');
      const surface = state.newSectionSurface;
      state.doc.surfaces = placeSection(stage, state.doc.surfaces ?? [], { surface, from, to });
      state.sectionStart = null;
      state.selectedSection = state.doc.surfaces.findIndex((section) => section.surface === surface && section.from <= from + 1 && section.to >= to - 1);
      await sectionsChanged(stage);
      setStatus(`${STAGE_SURFACES[surface].label} from ${Math.round(from)} m to ${Math.round(to)} m.`);
    }),
    cancelSectionStart() {
      state.sectionStart = null;
      setStatus('');
    },
    /** `toggle`: selecting the selected section again clears it. */
    selectSection(i, toggle = true) {
      state.selectedSection = toggle && state.selectedSection === i ? -1 : i;
      changed({ save: false });
    },
    /** Selected section: another surface (merging with same-surface neighbours). */
    setSectionSurface: guard(async (id) => {
      const section = state.doc.surfaces?.[state.selectedSection];
      if (!section || section.surface === id) return;
      const stage = await lineFor(false, 'Section');
      const others = state.doc.surfaces.filter((s) => s !== section);
      state.doc.surfaces = placeSection(stage, others, { surface: id, from: section.from, to: section.to });
      state.selectedSection = state.doc.surfaces.findIndex((s) => s.surface === id && s.from <= section.from && s.to >= section.to);
      await sectionsChanged(stage);
      setStatus('');
    }),
    deleteSection: guard(async () => {
      const surfaces = state.doc.surfaces;
      if (!surfaces?.[state.selectedSection]) return;
      // Only the surface calls need the line.
      const stage = state.doc.pacenotes?.notes.length || state.doc.reversePacenotes?.notes.length ? await lineFor(false, 'Section') : null;
      surfaces.splice(state.selectedSection, 1);
      state.selectedSection = Math.min(state.selectedSection, surfaces.length - 1);
      if (stage) await sectionsChanged(stage);
      else changed();
      setStatus('');
    }),
    goToSection() {
      const section = state.doc.surfaces?.[state.selectedSection];
      if (section) addressSearch.teleport(section.points[0][0], section.points[0][1], `${STAGE_SURFACES[section.surface].label} section`);
    },

    /** Course object at the car, facing its way, after the selected one; selected. */
    placeObject(type) {
      const body = carManager.getVehicle()?.chassisBody;
      if (!body) return;
      const { position: pos, quaternion: q } = body;
      const object = { type, ...viewFrame.toLatLon(pos.x, pos.z), heading: facing(q) };
      if (format.objectTypes[type].chain) object.length = format.objectTypes[type].defaultLength;
      const at = state.selectedObject >= 0 ? state.selectedObject + 1 : state.doc.objects.length;
      state.doc.objects.splice(at, 0, object);
      state.selectedObject = at;
      changed();
    },
    selectObject(i) {
      state.selectedObject = state.selectedObject === i ? -1 : i;
      changed({ save: false });
    },
    /** Selected object: 'heading' (compass degrees) or 'length' (tape, m). */
    setObjectField(field, value) {
      const object = state.doc.objects[state.selectedObject];
      if (!object || !Number.isFinite(value)) return;
      object[field] = field === 'heading' ? format.normalHeading(value) : value;
      changed();
    },
    /** Selected object (a stage's): 'forward' | 'reverse' = in that stage version only, null = both. */
    setObjectOnly(value) {
      const object = state.doc.objects[state.selectedObject];
      if (!object) return;
      if (value) object.only = value;
      else delete object.only;
      changed();
    },
    moveObjectToCar() {
      const object = state.doc.objects[state.selectedObject];
      const pos = carManager.getVehicle()?.chassisBody.position;
      if (!object || !pos) return;
      Object.assign(object, viewFrame.toLatLon(pos.x, pos.z));
      changed();
    },
    deleteObject() {
      if (!state.doc.objects[state.selectedObject]) return;
      state.doc.objects.splice(state.selectedObject, 1);
      state.selectedObject = Math.min(state.selectedObject, state.doc.objects.length - 1);
      changed();
    },
    goToObject() {
      const object = state.doc.objects[state.selectedObject];
      if (object) addressSearch.teleport(object.lat, object.lon, format.objectTypes[object.type].label);
    },

    loadIndex: guard(async () => {
      setStatus('Loading…');
      await loadIndex();
      setStatus(`Stages from ${state.source}`);
    }),
    /** A file picked in the scenario tree. Stages still come from the publish branch. */
    openPicked: guard(async ({ source, kindId, key, json }) => {
      if ((state.doc.items.length || state.doc.objects.length) && !window.confirm(`Open ${key}? Unsaved points will be lost.`)) return;
      await loadIndex();
      // The file's folder is where it's saved back to.
      state.doc = { kind: kindId, objects: [], surfaces: [], ...kindById.get(kindId).fromFile(json), ...splitKey(key) };
      state.selected = -1;
      state.selectedNote = -1;
      state.selectedSection = -1;
      state.sectionStart = null;
      state.selectedObject = -1;
      changed();
      setStatus(`Opened ${key} from ${formatSource(source)}`);
    }),

    problems: () => kind().validate(state.doc),
    exportJson: toFileJson,
    fileName: () => filePath(format.folder, kind(), fileKey({ ...state.doc, id: state.doc.id || 'unnamed' })),

    save: guard(async () => {
      const problems = kind().validate(state.doc);
      if (problems.length) throw new Error(problems.join('; '));
      if (!publishEnabled()) throw new Error('Publishing is off in this build: use Export');
      await refreshRoutes();
      const branch = branchNameFor(getPlayerName());
      setStatus(`Publishing to branch ${branch}…`);
      const result = await publishScenario({
        branch,
        folder: format.folder,
        kindFolder: kind().folder,
        key: fileKey(state.doc),
        content: toFileJson(),
      });
      await useIndexOf(await openSource({ owner: result.owner, repo: result.repo, ref: result.branch }, result.sha));
      setStatus(result.unchanged ? 'No changes to publish' : `Published, sent for review. Play it from source ${state.source}`);
    }),

    /** The file's placed points for the minimap, numbered like their 3D markers. */
    mapPoints() {
      const points = [];
      listItems().forEach(({ index: i, item, point, driven }, n) => {
        const def = format.pointTypes[point.type];
        if (!def || !driven || item.lat == null) return;
        // Repeats share the gate's icon, numbered with it.
        const label = [n + 1, ...repeatNumbers(item)].join('·');
        const selected = i === state.selected || editor.repeatTarget(state.selected) === item;
        points.push({ lat: item.lat, lon: item.lon, color: def.color, label, gate: !!def.gate, selected });
      });
      const note = editedNotes()?.notes[state.selectedNote];
      if (note) points.push({ lat: note.lat, lon: note.lon, color: NOTE_COLOR, label: noteLabel(note), gate: false, selected: true });
      const object = state.doc.objects[state.selectedObject];
      if (object) {
        const def = format.objectTypes[object.type];
        points.push({ lat: object.lat, lon: object.lon, color: def.color, label: def.short, gate: false, selected: true });
      }
      const section = state.doc.surfaces?.[state.selectedSection];
      if (section) points.push({ lat: section.points[0][0], lon: section.points[0][1], color: SECTION_COLOR, label: STAGE_SURFACES[section.surface].label, gate: false, selected: true });
      return points;
    },

    /** Per frame: markers for the current file's points and their roadside boards; course objects stand and get knocked. */
    update(dt) {
      const now = performance.now();
      const entries = [];
      let selectedResolved = false;
      const list = listItems();
      const view = list.filter((entry) => entry.driven);
      const frameMap = reversed() ? reverseFrames : frames;
      view.forEach((entry, k) => {
        const { item, point, index: i } = entry;
        const def = format.pointTypes[point.type];
        if (!def) return;
        const number = list.indexOf(entry) + 1;
        let { x, z } = viewFrame.fromLatLon(item.lat, item.lon);
        let dir = frameMap.get(item);
        if (def.gate) {
          // Facing depends on the neighbours: recomputed when any of them moves.
          const at = (e) => {
            const p = e && pointOf(e.item);
            return p ? `${p.lat},${p.lon}` : '';
          };
          const signature = `${at(entry)},${point.heading},${item.snap}|${at(view[k - 1])}|${at(view[k + 1])}`;
          if (dir?.signature !== signature || (dir.failedAt != null && now - dir.failedAt > DIR_RETRY_MS)) {
            dir = { signature, ...(resolveFrame(view, k, x, z) ?? { failedAt: now }) };
            frameMap.set(item, dir);
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
          width: point.width ?? 0,
          color: def.color,
          label: `${[number, ...repeatNumbers(item)].join('·')} ${def.short}`,
          selected: i === state.selected || editor.repeatTarget(state.selected) === item,
          x,
          y,
          z,
          dirX: dir?.dirX ?? 0,
          dirZ: dir?.dirZ ?? 0,
        });
      });
      const car = carManager.getVehicle()?.chassisBody.position;
      const pacenotes = editedNotes();
      if (state.showNoteBoards) pacenotes?.notes.forEach((note, i) => {
        const { x, z } = viewFrame.fromLatLon(note.lat, note.lon);
        if (!car || Math.hypot(x - car.x, z - car.z) > NOTE_MARKER_M) return;
        const y = terrain.surfaceHeightAt(x, z);
        if (y == null) return;
        entries.push({ key: note, note, label: noteLabel(note), gap: gapLabel(pacenotes, i), selected: i === state.selectedNote, hover: i === state.hoverNote, x, y, z, dirX: 0, dirZ: 0 });
      });
      state.doc.objects.forEach((object, i) => {
        if (!inVersion(object, reversed())) return;
        const { x, z } = viewFrame.fromLatLon(object.lat, object.lon);
        if (i !== state.selectedObject && (!car || Math.hypot(x - car.x, z - car.z) > OBJECT_LABEL_M)) return;
        const y = terrain.surfaceHeightAt(x, z);
        const def = format.objectTypes[object.type];
        if (y != null) entries.push({ key: object, tag: true, color: def.color, label: `${i + 1} ${def.short}`, selected: i === state.selectedObject, x, y, z, dirX: 0, dirZ: 0 });
      });
      markers.sync(entries);
      syncRoute(now);
      syncReverseRoute(now);
      routeLine.update(state.doc.kind === 'stage' ? car : null);
      reverseLine.update(state.doc.kind === 'stage' ? car : null);
      if (scenery) {
        if (sceneryDirty) syncScenery();
        sceneryDirty = false;
        scenery.update(dt, car);
      }
      // The dial shows the road's direction once it's known.
      if (selectedResolved) changed({ save: false });
    },

    shiftOrigin(dx, dz) {
      scenery?.shiftOrigin(dx, dz);
      routeLine.shiftOrigin();
      reverseLine.shiftOrigin();
    },
  };
  syncSurfaces(); // the draft's
  routeLine.setVisible(state.showRoute);
  reverseLine.setVisible(state.showReverseRoute);
  return editor;
}
