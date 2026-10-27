// Editor side of stage surface sections (format: stageSurfaces.js): a section's points from metres
// along the stage line (pacenotes.js stageLine), and placing a new one over the others - it wins
// where they overlap, touching ones of the same surface become one.

import { localToLatLon } from '../geo.js';

const COORD_DECIMALS = 6;
const WIDTH_DECIMALS = 1;
const MIN_LENGTH_M = 5; // shorter leftovers of a trimmed section are dropped
const MERGE_GAP_M = 1;

/** Centreline points [lat, lon, width] of the line from `from` to `to` metres: its ends plus the road's vertices between. */
function pointsBetween({ origin, nodes, samples }, from, to) {
  const { nodeS } = samples;
  const points = [];
  const push = (x, z, width) => {
    const { lat, lon } = localToLatLon(x, z, origin.lat, origin.lon);
    points.push([Number(lat.toFixed(COORD_DECIMALS)), Number(lon.toFixed(COORD_DECIMALS)), Number(width.toFixed(WIDTH_DECIMALS))]);
  };
  for (let i = 0; i + 1 < nodes.length; i++) {
    const s0 = nodeS[i];
    const s1 = nodeS[i + 1];
    if (s1 <= from) continue;
    if (s0 >= to) break;
    const a = nodes[i];
    const b = nodes[i + 1];
    const width = a.links.find((l) => l.node === b)?.width ?? 6;
    const at = (s) => {
      const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
      return [a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t];
    };
    if (!points.length) push(...at(Math.max(from, s0)), width);
    else push(a.x, a.z, width);
    if (s1 >= to) {
      push(...at(to), width);
      break;
    }
  }
  return points;
}

/** A section of `surface` over the line from `from` to `to` metres. */
export function sectionOn(line, surface, from, to) {
  return { surface, from: Math.round(from), to: Math.round(to), points: pointsBetween(line, from, to) };
}

/** `sections` with `added` ({ surface, from, to }) laid over them, in order along the stage. */
export function placeSection(line, sections, added) {
  const { from, to } = added;
  const out = [];
  for (const section of sections) {
    if (section.to <= from || section.from >= to) {
      out.push(section);
      continue;
    }
    if (section.from < from) out.push(sectionOn(line, section.surface, section.from, from));
    if (section.to > to) out.push(sectionOn(line, section.surface, to, section.to));
  }
  out.push(sectionOn(line, added.surface, from, to));
  out.sort((p, q) => p.from - q.from);
  const merged = [];
  for (const section of out) {
    const last = merged[merged.length - 1];
    if (last?.surface === section.surface && section.from - last.to <= MERGE_GAP_M) {
      merged[merged.length - 1] = sectionOn(line, section.surface, last.from, Math.max(last.to, section.to));
    } else merged.push(section);
  }
  return merged.filter((section) => section.to - section.from >= MIN_LENGTH_M && section.points.length >= 2);
}
