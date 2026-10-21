// Rally scenario files (format in the scenarios repo README): stages are ordered gates,
// rallies are a base plus an itinerary of gates and stage references. Also the editor's
// definition for the mode: file kinds, point types and their fields.

import { SCENARIO_FORMAT } from '../../config.js';

const DEFAULT_GATE_WIDTH_M = 10;
const COORD_DECIMALS = 6; // ~0.1 m

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// gate: placed across the nearest road and has a width; single: at most one per file.
const POINT_TYPES = {
  timeControl: { label: 'Time control', short: 'TC', color: 0xf2c200, gate: true },
  start: { label: 'Start', short: 'START', color: 0x20b040, gate: true },
  split: { label: 'Split', short: 'SPLIT', color: 0x2f7fff, gate: true },
  passageControl: { label: 'Passage control', short: 'PC', color: 0x9b4dff, gate: true },
  finish: { label: 'Flying finish', short: 'FINISH', color: 0xe02020, gate: true },
  stop: { label: 'Stop control', short: 'STOP', color: 0x901010, gate: true },
  base: { label: 'Rally base', short: 'BASE', color: 0x1060c0, single: true },
  serviceParkIn: { label: 'Service park in', short: 'SP IN', color: 0x00b0c0, gate: true },
  serviceParkOut: { label: 'Service park out', short: 'SP OUT', color: 0x00b0c0, gate: true },
  regroup: { label: 'Regroup', short: 'REGROUP', color: 0x909090, gate: true },
  refuel: { label: 'Refuel zone', short: 'FUEL', color: 0xff8a00, gate: true },
  tyreFitting: { label: 'Tyre fitting', short: 'TYRES', color: 0x404040, gate: true },
  remoteService: { label: 'Remote service', short: 'RSZ', color: 0x008a70, gate: true },
  parcFerme: { label: 'Parc fermé', short: 'PARC', color: 0xf0f0f0, gate: true },
  podium: { label: 'Podium', short: 'PODIUM', color: 0xd4a017, gate: true },
};

const STAGE_POINTS = ['timeControl', 'start', 'split', 'passageControl', 'finish', 'stop'];
const RALLY_POINTS = ['base', 'serviceParkIn', 'serviceParkOut', 'regroup', 'refuel', 'tyreFitting', 'remoteService', 'parcFerme', 'podium'];

const round = (v) => Number(v.toFixed(COORD_DECIMALS));
const gate = ({ type, lat, lon, width }) => ({ type, lat: round(lat), lon: round(lon), width: round(width ?? DEFAULT_GATE_WIDTH_M) });

function readGate(entry) {
  if (!POINT_TYPES[entry?.type] || !Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) return null;
  return { type: entry.type, lat: entry.lat, lon: entry.lon, width: Number.isFinite(entry.width) ? entry.width : DEFAULT_GATE_WIDTH_M };
}

function validateCommon(doc, problems) {
  if (!ID_RE.test(doc.id ?? '')) problems.push('ID: lowercase letters, digits and dashes only');
  if (!doc.name?.trim()) problems.push('Name is empty');
  for (const item of doc.items) {
    if (POINT_TYPES[item.type]?.gate && !(item.width > 0)) problems.push(`${POINT_TYPES[item.type].label}: width must be above 0`);
  }
}

/** Editor/loader definition of the rally mode. Documents: { kind, id, name, items }. */
export const rallyFormat = {
  folder: 'rally',
  defaultGateWidth: DEFAULT_GATE_WIDTH_M,
  pointTypes: POINT_TYPES,
  kinds: [
    {
      id: 'stage',
      label: 'Stage',
      folder: 'stages',
      indexKey: 'stages',
      points: STAGE_POINTS,
      toFile: (doc) => ({ format: SCENARIO_FORMAT, id: doc.id, name: doc.name, points: doc.items.map(gate) }),
      fromFile: (json) => ({ id: json.id ?? '', name: json.name ?? '', items: (json.points ?? []).map(readGate).filter(Boolean) }),
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
          id: doc.id,
          name: doc.name,
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
        return { id: json.id ?? '', name: json.name ?? '', items };
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
