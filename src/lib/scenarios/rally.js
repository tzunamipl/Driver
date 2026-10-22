// Rally scenario files (format in the scenarios repo README): stages are ordered gates,
// rallies are a base plus an itinerary of gates and stage references (stage file keys,
// lib/scenarios/paths.js). Both sit in a country / region-or-theme folder. Also the editor's
// definition for the mode: file kinds, point types and their fields.

import { SCENARIO_FORMAT } from '../../config.js';

const DEFAULT_GATE_WIDTH_M = 10;
const NARROW_GATE_WIDTH_M = 4; // stop controls and service zones: about one lane
const COORD_DECIMALS = 6; // ~0.1 m

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// gate: placed across the nearest road and has a width (defaultWidth, else DEFAULT_GATE_WIDTH_M); single: at most one per file;
// stop: a liaison point done by stopping in its zone instead of driving through;
// description: what the point does in the game (editor tooltips).
const POINT_TYPES = {
  timeControl: {
    label: 'Time control', short: 'TC', color: 0xf2c200, gate: true, defaultWidth: NARROW_GATE_WIDTH_M,
    description: 'Check-in before the stage: the driver stops in its zone (15 m), then drives on to the start. Place it shortly before the start.',
  },
  start: {
    label: 'Start', short: 'START', color: 0x20b040, gate: true, defaultWidth: NARROW_GATE_WIDTH_M,
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
    label: 'Stop control', short: 'STOP', color: 0x901010, gate: true, defaultWidth: NARROW_GATE_WIDTH_M,
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
    label: 'Refuel zone', short: 'FUEL', color: 0xff8a00, gate: true, defaultWidth: NARROW_GATE_WIDTH_M,
    description: 'Liaison checkpoint at a refuelling zone: drive through it, from either direction.',
  },
  tyreFitting: {
    label: 'Tyre fitting', short: 'TYRES', color: 0x404040, gate: true, defaultWidth: NARROW_GATE_WIDTH_M, stop: true,
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
const gate = ({ type, lat, lon, width }) => ({ type, lat: round(lat), lon: round(lon), width: round(width ?? defaultWidth(type)) });

function readGate(entry) {
  if (!POINT_TYPES[entry?.type] || !Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) return null;
  return { type: entry.type, lat: entry.lat, lon: entry.lon, width: Number.isFinite(entry.width) ? entry.width : defaultWidth(entry.type) };
}

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
  pointTypes: POINT_TYPES,
  kinds: [
    {
      id: 'stage',
      label: 'Stage',
      folder: 'stages',
      indexKey: 'stages',
      points: STAGE_POINTS,
      toFile: (doc) => ({ format: SCENARIO_FORMAT, ...fileMeta(doc), points: doc.items.map(gate) }),
      fromFile: (json) => ({ ...docMeta(json), items: (json.points ?? []).map(readGate).filter(Boolean) }),
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
      toFile(doc) {
        const base = doc.items.find((item) => item.type === 'base');
        return {
          format: SCENARIO_FORMAT,
          ...fileMeta(doc),
          base: base ? { name: base.name ?? '', lat: round(base.lat), lon: round(base.lon) } : null,
          itinerary: doc.items
            .filter((item) => item.type !== 'base')
            .map((item) => (item.type === 'ref' ? { stage: item.ref, ...(item.name ? { name: item.name } : {}) } : gate(item))),
        };
      },
      fromFile(json) {
        const items = [];
        if (Number.isFinite(json.base?.lat) && Number.isFinite(json.base?.lon)) {
          items.push({ type: 'base', lat: json.base.lat, lon: json.base.lon, name: json.base.name ?? '' });
        }
        for (const entry of json.itinerary ?? []) {
          if (typeof entry?.stage === 'string') items.push({ type: 'ref', ref: entry.stage, name: entry.name ?? '' });
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
        return problems;
      },
    },
  ],
};
