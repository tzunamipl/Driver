// Rally scenario files (format in the scenarios repo README): stages are ordered gates
// (plus optional pacenotes, lib/rally/pacenoteCalls.js),
// rallies are a base plus an itinerary of gates, stage references (stage file keys,
// lib/scenarios/paths.js) and point references ({ point: id } = the gate with that `id` again).
// Both sit in a country / region-or-theme folder. Also the editor's
// definition for the mode: file kinds, point types and their fields.

import { SCENARIO_FORMAT } from '../../config.js';
import { boardSpots } from '../rally/controlScenery.js';
import { BOARD_COLORS } from '../rally/fiaBoards.js';
import { DIRS, GRADES } from '../rally/pacenoteCalls.js';

const DEFAULT_GATE_WIDTH_M = 10;
const NARROW_GATE_WIDTH_M = 4; // service zones: about one lane
const STAGE_CONTROL_WIDTH_M = 3; // time control, start, stop: one car at a time
const COORD_DECIMALS = 6; // ~0.1 m
const HEADING_DECIMALS = 1;

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// gate: placed across the nearest road (file `snap: false` = exactly at its lat/lon), facing along it or its optional heading (compass degrees of travel), and has a width (defaultWidth, else DEFAULT_GATE_WIDTH_M); single: at most one per file;
// stop: a liaison point done by stopping in its zone instead of driving through; tyres: passing it fits fresh tyres; refuel: passing it offers fuel;
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
    label: 'Split', short: 'SPLIT', color: 0x2f7fff, gate: true,
    description: 'Intermediate timing point between start and finish: crossing it records a split time compared with the best run. Flags, fireworks and sparkles.',
  },
  passageControl: {
    label: 'Passage control', short: 'PC', color: 0x9b4dff, gate: true,
    description: 'Required checkpoint: the stage only counts it when crossed in order, so use it to block shortcuts. Small purple PC flags, sparkles when passed; not timed.',
  },
  finish: {
    label: 'Flying finish', short: 'FINISH', color: 0xe02020, gate: true,
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
  remoteService: {
    label: 'Remote service', short: 'RSZ', color: 0x008a70, gate: true,
    description: 'Liaison checkpoint at a remote service zone away from the base: drive through it.',
  },
  parcFerme: {
    label: 'Parc fermé', short: 'PARC', color: 0xf0f0f0, gate: true,
    description: 'Closed park at the end of a leg or the rally: drive through it.',
  },
  podium: {
    label: 'Podium', short: 'PODIUM', color: 0xd4a017, gate: true,
    description: 'Ceremonial start / finish ramp with an arch: drive through it.',
  },
};

const STAGE_POINTS = ['timeControl', 'start', 'split', 'passageControl', 'finish', 'stop'];
const RALLY_POINTS = ['base', 'serviceParkIn', 'serviceParkOut', 'regroup', 'refuel', 'tyreFitting', 'remoteService', 'parcFerme', 'podium'];

const round = (v) => Number(v.toFixed(COORD_DECIMALS));
const defaultWidth = (type) => POINT_TYPES[type].defaultWidth ?? DEFAULT_GATE_WIDTH_M;
const normalHeading = (deg) => Number((((deg % 360) + 360) % 360).toFixed(HEADING_DECIMALS)) % 360;
const gate = ({ type, id, lat, lon, width, heading, snap }) => ({
  type,
  ...(id ? { id } : {}),
  lat: round(lat),
  lon: round(lon),
  width: round(width ?? defaultWidth(type)),
  ...(Number.isFinite(heading) ? { heading: normalHeading(heading) } : {}),
  ...(snap === false ? { snap: false } : {}),
});

function readGate(entry) {
  if (!POINT_TYPES[entry?.type] || !Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) return null;
  const point = { type: entry.type, lat: entry.lat, lon: entry.lon, width: Number.isFinite(entry.width) ? entry.width : defaultWidth(entry.type) };
  if (Number.isFinite(entry.heading)) point.heading = normalHeading(entry.heading);
  if (entry.snap === false) point.snap = false;
  if (typeof entry.id === 'string' && entry.id) point.id = entry.id;
  return point;
}

const isPointRef = (item) => item?.type === 'pointRef';

/** Rally items with each point reference replaced by a copy of its gate; throws on an unknown id. */
export function resolvePointRefs(items) {
  const byId = new Map(items.filter((item) => item.id && POINT_TYPES[item.type]?.gate).map((item) => [item.id, item]));
  return items.map((item) => {
    if (!isPointRef(item)) return item;
    const target = byId.get(item.ref);
    if (!target) throw new Error(`Point "${item.ref}" is not in this rally`);
    return { ...target };
  });
}

const isRoutePoint = (p) => Number.isFinite(p?.lat) && Number.isFinite(p.lon) && Number.isFinite(p.s);
const readRoutePoint = (p) => ({ lat: p.lat, lon: p.lon, s: p.s });
const writeRoutePoint = (p) => ({ lat: round(p.lat), lon: round(p.lon), s: p.s });

/** Stage file `pacenotes` -> { length, notes } (pacenoteCalls.js), or null; bad notes are dropped. */
function readPacenotes(entry) {
  if (!Number.isFinite(entry?.length) || !Array.isArray(entry.notes)) return null;
  const notes = entry.notes
    .filter((n) => isRoutePoint(n) && isRoutePoint(n.show) && isRoutePoint(n.apex) && DIRS.includes(n.dir))
    .filter((n) => n.dir === 'S' || GRADES.includes(n.grade))
    .map((n) => ({
      lat: n.lat,
      lon: n.lon,
      s: n.s,
      len: Number.isFinite(n.len) ? n.len : 0,
      dir: n.dir,
      ...(n.dir === 'S' ? {} : { grade: n.grade }),
      ...(n.junction ? { junction: true } : {}),
      show: readRoutePoint(n.show),
      apex: readRoutePoint(n.apex),
    }))
    .sort((p, q) => p.s - q.s);
  return { length: entry.length, notes };
}

const writePacenotes = (pacenotes) =>
  pacenotes?.notes.length
    ? { pacenotes: { length: pacenotes.length, notes: pacenotes.notes.map((n) => ({ ...n, lat: round(n.lat), lon: round(n.lon), show: writeRoutePoint(n.show), apex: writeRoutePoint(n.apex) })) } }
    : {};

const fileMeta = (doc) => ({ country: doc.country, region: doc.region, id: doc.id, name: doc.name });
const docMeta = (json) => ({ country: json.country ?? '', region: json.region ?? '', id: json.id ?? '', name: json.name ?? '' });

function validateCommon(doc, problems) {
  if (!ID_RE.test(doc.country ?? '')) problems.push('Country: lowercase letters, digits and dashes only');
  if (!ID_RE.test(doc.region ?? '')) problems.push('Region / theme: lowercase letters, digits and dashes only');
  if (!ID_RE.test(doc.id ?? '')) problems.push('ID: lowercase letters, digits and dashes only');
  if (!doc.name?.trim()) problems.push('Name is empty');
  for (const item of doc.items) {
    if (POINT_TYPES[item.type]?.gate && !(item.width > 0)) problems.push(`${POINT_TYPES[item.type].label}: width must be above 0`);
  }
}

/** Editor/loader definition of the rally mode. Documents: { kind, country, region, id, name, items }. */
export const rallyFormat = {
  folder: 'rally',
  defaultGateWidth: defaultWidth,
  normalHeading,
  // Roadside boards the game adds around a point (editor preview).
  satellites: (type) => boardSpots(type).map(([color, along, facing]) => ({ color: BOARD_COLORS[color], along, facing })),
  pointTypes: POINT_TYPES,
  kinds: [
    {
      id: 'stage',
      label: 'Stage',
      folder: 'stages',
      indexKey: 'stages',
      points: STAGE_POINTS,
      toFile: (doc) => ({ format: SCENARIO_FORMAT, ...fileMeta(doc), points: doc.items.map(gate), ...writePacenotes(doc.pacenotes) }),
      fromFile: (json) => ({ ...docMeta(json), items: (json.points ?? []).map(readGate).filter(Boolean), pacenotes: readPacenotes(json.pacenotes) }),
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
      toFile(doc) {
        const base = doc.items.find((item) => item.type === 'base');
        return {
          format: SCENARIO_FORMAT,
          ...fileMeta(doc),
          base: base ? { name: base.name ?? '', lat: round(base.lat), lon: round(base.lon) } : null,
          itinerary: doc.items
            .filter((item) => item.type !== 'base')
            .map((item) =>
              item.type === 'ref' ? { stage: item.ref, ...(item.name ? { name: item.name } : {}) } : isPointRef(item) ? { point: item.ref } : gate(item)
            ),
        };
      },
      fromFile(json) {
        const items = [];
        if (Number.isFinite(json.base?.lat) && Number.isFinite(json.base?.lon)) {
          items.push({ type: 'base', lat: json.base.lat, lon: json.base.lon, name: json.base.name ?? '' });
        }
        for (const entry of json.itinerary ?? []) {
          if (typeof entry?.stage === 'string') items.push({ type: 'ref', ref: entry.stage, name: entry.name ?? '' });
          else if (typeof entry?.point === 'string') items.push({ type: 'pointRef', ref: entry.point });
          else {
            const point = readGate(entry);
            if (point) items.push(point);
          }
        }
        return { ...docMeta(json), items };
      },
      validate(doc) {
        const problems = [];
        validateCommon(doc, problems);
        if (!doc.items.some((item) => item.type === 'ref')) problems.push('A rally needs at least one stage');
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
