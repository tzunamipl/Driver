// Rally scenario files (format in the scenarios repo README): stages are ordered gates
// (plus optional pacenotes, lib/rally/pacenoteCalls.js),
// rallies are a base plus an itinerary of gates, stage references (stage file keys,
// lib/scenarios/paths.js; `reverse: true` = driven the other way, lib/rally/stageReverse.js) and point references ({ point: id } = the gate with that `id` again;
// a repeated parc fermé can carry its own `nextStart`).
// Either can carry course `objects` (hay bales, tapes, warning signs: lib/rally/courseProps.js);
// stages also surface sections (`surfaces`, lib/rally/stageSurfaces.js) and their reverse version's
// `reversePacenotes`, and each version's saved road line (`route`, `reverseRoute`, lib/rally/savedRoute.js);
// their passage controls and objects can be in one version only (`only`, lib/rally/stageReverse.js).
// Both sit in a country / region-or-theme folder. Also the editor's
// definition for the mode: file kinds, point types and their fields.

import { SCENARIO_FORMAT } from '../../config.js';
import { readMeta } from './fileMeta.js';
import { boardSpots } from '../rally/controlScenery.js';
import { BOARD_COLORS } from '../rally/fiaBoards.js';
import { DIRS, GRADES, CRESTS } from '../rally/pacenoteCalls.js';
import { STAGE_SURFACES } from '../rally/stageSurfaces.js';
import { VERSIONS, drivenType } from '../rally/stageReverse.js';

const DEFAULT_GATE_WIDTH_M = 10;
const NARROW_GATE_WIDTH_M = 4; // service zones: about one lane
const STAGE_CONTROL_WIDTH_M = 3; // time control, start, stop: one car at a time
const COORD_DECIMALS = 6; // ~0.1 m
const HEADING_DECIMALS = 1;

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Rally day start (local to the rally): the file's `startTime` for day 1, a parc fermé's `nextStart` for the day after it.
export const DEFAULT_START_TIME = '08:00';

/** 'HH:MM' -> minutes after midnight, or null. */
export function parseClockTime(text) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(typeof text === 'string' ? text.trim() : '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// gate: placed across the nearest road (file `snap: false` = exactly at its lat/lon), facing along it or its optional heading (compass degrees of travel), and has a width (defaultWidth, else DEFAULT_GATE_WIDTH_M); single: at most one per file;
// routed: a stage route point (pacenotes, editor route line); file `straight: true` = the route reaches it in a straight line from the point before, not by road
// (`straightReverse: true` = the same driving the reverse version, where its type routes there); versions: file `only` = in one stage version;
// stop: a liaison point done by stopping in its zone instead of driving through; tyres: passing it fits fresh tyres; refuel: passing it offers fuel;
// service: passing it opens that lib/serviceRepairs.js SERVICE_ZONES repair menu; endsDay: passing it ends the rally day (`nextStart` field);
// description: what the point does in the game (editor tooltips).
const POINT_TYPES = {
  timeControl: {
    label: 'Time control', short: 'TC', color: 0xf2c200, gate: true, defaultWidth: STAGE_CONTROL_WIDTH_M,
    description: 'Check-in before the stage: the driver stops in its zone (15 m), then drives on to the start. Place it shortly before the start.',
  },
  start: {
    label: 'Start', short: 'START', color: 0x20b040, gate: true, defaultWidth: STAGE_CONTROL_WIDTH_M,
    description: 'Start line: the car stops at it for a 5-light countdown and the clock starts at GO. Moving before GO is a jump start (+10 s). Exactly one per stage.',
  },
  split: {
    label: 'Split', short: 'SPLIT', color: 0x2f7fff, gate: true, routed: true,
    description: 'Intermediate timing point between start and finish: crossing it records a split time compared with the best run. Flags, fireworks and sparkles.',
  },
  passageControl: {
    label: 'Passage control', short: 'PC', color: 0x9b4dff, gate: true, routed: true, versions: true,
    description: 'Required checkpoint: the stage only counts it when crossed in order, so use it to block shortcuts. Small purple PC flags, sparkles when passed; not timed.',
  },
  finish: {
    label: 'Flying finish', short: 'FINISH', color: 0xe02020, gate: true, routed: true,
    description: 'Crossing it at speed stops the clock: this is the stage time. Exactly one per stage, after the start.',
  },
  stop: {
    label: 'Stop control', short: 'STOP', color: 0x901010, gate: true, defaultWidth: STAGE_CONTROL_WIDTH_M,
    description: 'A little after the finish: the car must stop in its zone (15 m) to end the stage and see the results.',
  },
  base: {
    label: 'Rally base', short: 'BASE', color: 0x1060c0, single: true,
    description: "The rally's service park and home. One per rally; not a checkpoint.",
  },
  serviceParkIn: {
    label: 'Service park in', short: 'SP IN', color: 0x00b0c0, gate: true, defaultWidth: NARROW_GATE_WIDTH_M,
    description: 'Liaison checkpoint at the service park entry: drive through it on the way into service.',
  },
  serviceParkOut: {
    label: 'Service park out', short: 'SP OUT', color: 0x00b0c0, gate: true, defaultWidth: NARROW_GATE_WIDTH_M,
    description: 'Liaison checkpoint at the service park exit: drive through it on the way out to the next stages.',
  },
  regroup: {
    label: 'Regroup', short: 'REGROUP', color: 0x909090, gate: true,
    description: 'Liaison checkpoint where the field gathers between stages: drive through it.',
  },
  refuel: {
    label: 'Refuel zone', short: 'FUEL', color: 0xff8a00, gate: true, defaultWidth: NARROW_GATE_WIDTH_M, refuel: true,
    description: 'Liaison checkpoint at a refuelling zone: drive through it, from either direction, and choose how much fuel to add.',
  },
  tyreFitting: {
    label: 'Tyre fitting', short: 'TYRES', color: 0x404040, gate: true, defaultWidth: NARROW_GATE_WIDTH_M, stop: true, tyres: true,
    description: 'Liaison checkpoint at a tyre fitting zone: stop in its zone (15 m), from either direction, then drive on.',
  },
  service: {
    label: 'Service', short: 'SERVICE', color: 0x00b0c0, gate: true, defaultWidth: NARROW_GATE_WIDTH_M, stop: true, service: 'service',
    description: 'Service bay in the service park (between SP IN and SP OUT): stop in its zone (15 m), from either direction, and repair the car within a 30 min time budget; going over costs 10 s per started minute.',
  },
  remoteService: {
    label: 'Remote service', short: 'RSZ', color: 0x008a70, gate: true, stop: true, service: 'remoteService',
    description: 'Remote service zone away from the base: stop in its zone (15 m), from either direction, and let the small crew fix the car within a 15 min time budget (no new parts); going over costs 10 s per started minute.',
  },
  parcFerme: {
    label: 'Parc fermé', short: 'PARC', color: 0xf0f0f0, gate: true, endsDay: true,
    description: 'Closed park at the end of a day (leg) or the rally: drive through it. The night passes and the next day starts at its Next day start time (else the rally start time).',
  },
  podium: {
    label: 'Podium', short: 'PODIUM', color: 0xd4a017, gate: true,
    description: 'Ceremonial start / finish ramp with an arch: drive through it.',
  },
};

// Course objects: exactly at their lat/lon (never snapped), facing `heading` (compass degrees of travel);
// chain: tape on stakes across the heading, centred there, `length` metres (defaultLength when missing).
const OBJECT_TYPES = {
  hayBale: {
    label: 'Hay bale', short: 'BALE', color: 0xc9a24a,
    description: 'Round straw bale standing on its flat end. Solid: the car bounces off it and takes the hit. Build chicanes, or guard a tree or a ditch.',
  },
  tape: {
    label: 'Tape', short: 'TAPE', color: 0xd71e1e, chain: true, defaultLength: 12,
    description: 'Red-white plastic tape on stakes about every 3 m, running across its heading, centred where placed. Stakes knock over and the tape tears; they stand again once the car is far. Closes off junctions and shortcuts.',
  },
  warningSign: {
    label: 'Warning sign', short: 'SIGN', color: 0xff6a6a,
    description: 'Red-white striped board on a stand, facing cars that come along its heading. Knocks over like a post.',
  },
};
const LENGTH_DECIMALS = 1;

const STAGE_POINTS = ['timeControl', 'start', 'split', 'passageControl', 'finish', 'stop'];
const RALLY_POINTS = ['base', 'serviceParkIn', 'service', 'serviceParkOut', 'regroup', 'refuel', 'tyreFitting', 'remoteService', 'parcFerme', 'podium'];

const round = (v) => Number(v.toFixed(COORD_DECIMALS));
const defaultWidth = (type) => POINT_TYPES[type].defaultWidth ?? DEFAULT_GATE_WIDTH_M;
const normalHeading = (deg) => Number((((deg % 360) + 360) % 360).toFixed(HEADING_DECIMALS)) % 360;
const routedReverse = (type) => !!POINT_TYPES[drivenType(type, true)]?.routed;
const onlyField = (entry) => (VERSIONS.includes(entry.only) ? { only: entry.only } : {});
const gate = ({ type, id, lat, lon, width, heading, snap, straight, straightReverse, only, nextStart }) => ({
  type,
  ...(id ? { id } : {}),
  lat: round(lat),
  lon: round(lon),
  width: round(width ?? defaultWidth(type)),
  ...(Number.isFinite(heading) ? { heading: normalHeading(heading) } : {}),
  ...(snap === false ? { snap: false } : {}),
  ...(straight && POINT_TYPES[type].routed ? { straight: true } : {}),
  ...(straightReverse && routedReverse(type) ? { straightReverse: true } : {}),
  ...(POINT_TYPES[type].versions ? onlyField({ only }) : {}),
  ...(POINT_TYPES[type].endsDay && parseClockTime(nextStart) != null ? { nextStart: nextStart.trim() } : {}),
});

function readGate(entry) {
  if (!POINT_TYPES[entry?.type] || !Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) return null;
  const point = { type: entry.type, lat: entry.lat, lon: entry.lon, width: Number.isFinite(entry.width) ? entry.width : defaultWidth(entry.type) };
  if (Number.isFinite(entry.heading)) point.heading = normalHeading(entry.heading);
  if (entry.snap === false) point.snap = false;
  if (entry.straight === true && POINT_TYPES[entry.type].routed) point.straight = true;
  if (entry.straightReverse === true && routedReverse(entry.type)) point.straightReverse = true;
  if (POINT_TYPES[entry.type].versions) Object.assign(point, onlyField(entry));
  if (typeof entry.id === 'string' && entry.id) point.id = entry.id;
  if (POINT_TYPES[entry.type].endsDay && parseClockTime(entry.nextStart) != null) point.nextStart = entry.nextStart;
  return point;
}

function readObject(entry) {
  const def = OBJECT_TYPES[entry?.type];
  if (!def || !Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) return null;
  const object = { type: entry.type, lat: entry.lat, lon: entry.lon, heading: normalHeading(Number.isFinite(entry.heading) ? entry.heading : 0), ...onlyField(entry) };
  if (def.chain) object.length = entry.length > 0 ? entry.length : def.defaultLength;
  return object;
}

const writeObjects = (objects) =>
  objects?.length
    ? {
        objects: objects.map(({ type, lat, lon, heading, length, only }) => ({
          type,
          lat: round(lat),
          lon: round(lon),
          heading: normalHeading(heading),
          ...(OBJECT_TYPES[type].chain ? { length: Number(length.toFixed(LENGTH_DECIMALS)) } : {}),
          ...onlyField({ only }),
        })),
      }
    : {};
const readObjects = (json) => (Array.isArray(json.objects) ? json.objects.map(readObject).filter(Boolean) : []);

const isPointRef = (item) => item?.type === 'pointRef';

/** Rally items with each point reference replaced by a copy of its gate (own `nextStart` wins); throws on an unknown id. */
export function resolvePointRefs(items) {
  const byId = new Map(items.filter((item) => item.id && POINT_TYPES[item.type]?.gate).map((item) => [item.id, item]));
  return items.map((item) => {
    if (!isPointRef(item)) return item;
    const target = byId.get(item.ref);
    if (!target) throw new Error(`Point "${item.ref}" is not in this rally`);
    return { ...target, ...(POINT_TYPES[target.type].endsDay && parseClockTime(item.nextStart) != null ? { nextStart: item.nextStart.trim() } : {}) };
  });
}

const writePointRef = ({ ref, nextStart }) => ({ point: ref, ...(parseClockTime(nextStart) != null ? { nextStart: nextStart.trim() } : {}) });

const isRoutePoint = (p) => Number.isFinite(p?.lat) && Number.isFinite(p.lon) && Number.isFinite(p.s);
const readRoutePoint = (p) => ({ lat: p.lat, lon: p.lon, s: p.s });
const writeRoutePoint = (p) => ({ lat: round(p.lat), lon: round(p.lon), s: p.s });

const isCornerNote = (n) => DIRS.includes(n.dir) && (n.dir === 'S' || GRADES.includes(n.grade));
const readSurfaceNote = (n) => ({ lat: n.lat, lon: n.lon, s: n.s, len: 0, surface: n.surface, show: readRoutePoint(n.show), apex: readRoutePoint(n.apex) });
const readCrestNote = (n) => ({ lat: n.lat, lon: n.lon, s: n.s, len: 0, crest: n.crest, ...(n.caution ? { caution: true } : {}), show: readRoutePoint(n.show), apex: readRoutePoint(n.apex) });
const readCornerNote = (n) => ({
  lat: n.lat,
  lon: n.lon,
  s: n.s,
  len: Number.isFinite(n.len) ? n.len : 0,
  dir: n.dir,
  ...(n.dir === 'S' ? {} : { grade: n.grade }),
  ...(n.junction ? { junction: true } : {}),
  ...(n.caution ? { caution: true } : n.dir !== 'S' && n.descent > 0 ? { descent: Math.round(n.descent) } : {}),
  show: readRoutePoint(n.show),
  apex: readRoutePoint(n.apex),
});

/** Stage file `pacenotes` -> { length, notes } (pacenoteCalls.js), or null; bad notes are dropped. */
function readPacenotes(entry) {
  if (!Number.isFinite(entry?.length) || !Array.isArray(entry.notes)) return null;
  const notes = entry.notes
    .filter((n) => isRoutePoint(n) && isRoutePoint(n.show) && isRoutePoint(n.apex) && (STAGE_SURFACES[n.surface] || Object.hasOwn(CRESTS, n.crest ?? '') || isCornerNote(n)))
    .map((n) => (n.surface ? readSurfaceNote(n) : n.crest ? readCrestNote(n) : readCornerNote(n)))
    .sort((p, q) => p.s - q.s);
  return { length: entry.length, notes };
}

const writePacenotes = (pacenotes, key = 'pacenotes') =>
  pacenotes?.notes.length
    ? { [key]: { length: pacenotes.length, notes: pacenotes.notes.map((n) => ({ ...n, lat: round(n.lat), lon: round(n.lon), show: writeRoutePoint(n.show), apex: writeRoutePoint(n.apex) })) } }
    : {};

const isSurfacePoint = (p) => Array.isArray(p) && p.length >= 3 && p.every(Number.isFinite) && p[2] > 0;

/** Stage file `surfaces` -> sections (lib/rally/stageSurfaces.js) in order along the stage; bad ones are dropped. */
function readSurfaces(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e) => STAGE_SURFACES[e?.surface] && Number.isFinite(e.from) && Number.isFinite(e.to) && Array.isArray(e.points) && e.points.length >= 2 && e.points.every(isSurfacePoint))
    .map(({ surface, from, to, points }) => ({ surface, from, to, points: points.map(([lat, lon, width]) => [lat, lon, width]) }))
    .sort((p, q) => p.from - q.from);
}

const writeSurfaces = (surfaces) =>
  surfaces?.length
    ? { surfaces: surfaces.map(({ surface, from, to, points }) => ({ surface, from, to, points: points.map(([lat, lon, width]) => [round(lat), round(lon), Number(width.toFixed(LENGTH_DECIMALS))]) })) }
    : {};

const isRouteVertex = (p) => Array.isArray(p) && p.length === 3 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && (p[2] === 0 || p[2] === 1);

/** Stage file `route` / `reverseRoute` -> { key, length, points } (lib/rally/savedRoute.js), or null. */
function readRoute(entry) {
  if (typeof entry?.key !== 'string' || !Number.isFinite(entry.length) || !Array.isArray(entry.points)) return null;
  if (entry.points.length < 2 || !entry.points.every(isRouteVertex)) return null;
  return { key: entry.key, length: entry.length, points: entry.points.map(([lat, lon, unpaved]) => [lat, lon, unpaved]) };
}

const writeRoute = (route, key) =>
  route ? { [key]: { key: route.key, length: route.length, points: route.points.map(([lat, lon, unpaved]) => [round(lat), round(lon), unpaved]) } } : {};

const fileMeta = (doc) => ({ country: doc.country, region: doc.region, id: doc.id, name: doc.name, ...(doc.meta ? { meta: doc.meta } : {}) });
const docMeta = (json) => ({ country: json.country ?? '', region: json.region ?? '', id: json.id ?? '', name: json.name ?? '', meta: readMeta(json.meta) });

function validateCommon(doc, problems) {
  if (!ID_RE.test(doc.country ?? '')) problems.push('Country: lowercase letters, digits and dashes only');
  if (!ID_RE.test(doc.region ?? '')) problems.push('Region / theme: lowercase letters, digits and dashes only');
  if (!ID_RE.test(doc.id ?? '')) problems.push('ID: lowercase letters, digits and dashes only');
  if (!doc.name?.trim()) problems.push('Name is empty');
  for (const item of doc.items) {
    if (POINT_TYPES[item.type]?.gate && !(item.width > 0)) problems.push(`${POINT_TYPES[item.type].label}: width must be above 0`);
  }
  for (const object of doc.objects ?? []) {
    if (OBJECT_TYPES[object.type]?.chain && !(object.length > 0)) problems.push(`${OBJECT_TYPES[object.type].label}: length must be above 0`);
  }
}

/** Editor/loader definition of the rally mode. Documents: { kind, country, region, id, name, items } (+ rally `startTime`). */
export const rallyFormat = {
  folder: 'rally',
  defaultGateWidth: defaultWidth,
  normalHeading,
  // Roadside boards the game adds around a point (editor preview).
  satellites: (type) => boardSpots(type).map(([color, along, facing]) => ({ color: BOARD_COLORS[color], along, facing })),
  pointTypes: POINT_TYPES,
  objectTypes: OBJECT_TYPES,
  kinds: [
    {
      id: 'stage',
      label: 'Stage',
      folder: 'stages',
      indexKey: 'stages',
      points: STAGE_POINTS,
      toFile: (doc) => ({
        format: SCENARIO_FORMAT,
        ...fileMeta(doc),
        points: doc.items.map(gate),
        ...writePacenotes(doc.pacenotes),
        ...writePacenotes(doc.reversePacenotes, 'reversePacenotes'),
        ...writeSurfaces(doc.surfaces),
        ...writeObjects(doc.objects),
        ...writeRoute(doc.route, 'route'),
        ...writeRoute(doc.reverseRoute, 'reverseRoute'),
      }),
      fromFile: (json) => ({
        ...docMeta(json),
        items: (json.points ?? []).map(readGate).filter(Boolean),
        pacenotes: readPacenotes(json.pacenotes),
        reversePacenotes: readPacenotes(json.reversePacenotes),
        surfaces: readSurfaces(json.surfaces),
        objects: readObjects(json),
        route: readRoute(json.route),
        reverseRoute: readRoute(json.reverseRoute),
      }),
      validate(doc) {
        const problems = [];
        validateCommon(doc, problems);
        const types = doc.items.map((p) => p.type);
        const starts = types.filter((t) => t === 'start').length;
        const finishes = types.filter((t) => t === 'finish').length;
        if (starts !== 1) problems.push('A stage needs exactly one start');
        if (finishes !== 1) problems.push('A stage needs exactly one flying finish');
        if (starts === 1 && finishes === 1 && types.indexOf('finish') < types.indexOf('start')) problems.push('The finish comes before the start');
        return problems;
      },
    },
    {
      id: 'rally',
      label: 'Rally',
      folder: 'rallies',
      indexKey: 'rallies',
      points: RALLY_POINTS,
      // Itinerary entries referencing files of this kind.
      refKind: 'stage',
      // Gates can be driven again later: `id` on the gate, { point: id } entries.
      pointRefs: true,
      // Day 1 start when the file has no `startTime`.
      startTime: DEFAULT_START_TIME,
      toFile(doc) {
        const base = doc.items.find((item) => item.type === 'base');
        return {
          format: SCENARIO_FORMAT,
          ...fileMeta(doc),
          ...(parseClockTime(doc.startTime) != null ? { startTime: doc.startTime.trim() } : {}),
          base: base ? { name: base.name ?? '', lat: round(base.lat), lon: round(base.lon) } : null,
          itinerary: doc.items
            .filter((item) => item.type !== 'base')
            .map((item) =>
              item.type === 'ref'
                ? { stage: item.ref, ...(item.name ? { name: item.name } : {}), ...(item.reverse ? { reverse: true } : {}) }
                : isPointRef(item)
                  ? writePointRef(item)
                  : gate(item)
            ),
          ...writeObjects(doc.objects),
        };
      },
      fromFile(json) {
        const items = [];
        if (Number.isFinite(json.base?.lat) && Number.isFinite(json.base?.lon)) {
          items.push({ type: 'base', lat: json.base.lat, lon: json.base.lon, name: json.base.name ?? '' });
        }
        for (const entry of json.itinerary ?? []) {
          if (typeof entry?.stage === 'string') items.push({ type: 'ref', ref: entry.stage, name: entry.name ?? '', ...(entry.reverse === true ? { reverse: true } : {}) });
          else if (typeof entry?.point === 'string') items.push({ type: 'pointRef', ref: entry.point, ...(parseClockTime(entry.nextStart) != null ? { nextStart: entry.nextStart } : {}) });
          else {
            const point = readGate(entry);
            if (point) items.push(point);
          }
        }
        return { ...docMeta(json), startTime: parseClockTime(json.startTime) != null ? json.startTime : '', items, objects: readObjects(json) };
      },
      validate(doc) {
        const problems = [];
        validateCommon(doc, problems);
        if (!doc.items.some((item) => item.type === 'ref')) problems.push('A rally needs at least one stage');
        if (doc.startTime?.trim() && parseClockTime(doc.startTime) == null) problems.push('Start time: HH:MM, e.g. 08:00');
        for (const item of doc.items) {
          if (item.nextStart?.trim() && parseClockTime(item.nextStart) == null) problems.push(`${POINT_TYPES[item.type]?.label ?? `Repeat of "${item.ref}"`}: next day start HH:MM, e.g. 08:30`);
        }
        const ids = new Set();
        for (const item of doc.items) {
          if (!item.id) continue;
          if (!ID_RE.test(item.id)) problems.push(`Point ID "${item.id}": lowercase letters, digits and dashes only`);
          else if (ids.has(item.id)) problems.push(`Point ID "${item.id}" is used twice`);
          ids.add(item.id);
        }
        for (const item of doc.items) {
          if (isPointRef(item) && !ids.has(item.ref)) problems.push(`Repeat of "${item.ref}": no point has that ID`);
        }
        return problems;
      },
    },
  ],
};
