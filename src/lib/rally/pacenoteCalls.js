// Pacenote wording shared by the editor and the HUD. A note is { lat, lon, s, len, dir, grade,
// junction, show, apex }: s / len = metres along the stage where the corner starts and how long it is,
// dir 'L' | 'R' | 'S' (straight on at a junction, no grade), grade 1 (slowest) .. 6 (fastest),
// show / apex = { lat, lon, s }: a point before the corner and the apex, where the HUD stops showing the note.
// What follows a note (distance, "into", "and") comes from the gap to the next one, called in
// metres or yards (lib/units.js).

import { shortDistanceValue } from '../units.js';

export const DIRS = ['L', 'R', 'S'];
export const GRADES = [1, 2, 3, 4, 5, 6];
const INTO_M = 15;
const AND_M = 35;
// Called distances (metres or yards), rounded down to one of these (shorter is the safe side).
const CALLED_DISTANCES = [30, 40, 50, 60, 70, 80, 100, 120, 150, 200, 250, 300, 400, 500];
const LONG_STEP_M = 100;

export const noteLabel = (note) => (note.dir === 'S' ? 'Straight' : `${note.dir}${note.grade}`);

export function calledDistance(metres) {
  if (metres >= CALLED_DISTANCES[CALLED_DISTANCES.length - 1]) return Math.floor(metres / LONG_STEP_M) * LONG_STEP_M;
  return CALLED_DISTANCES.findLast((d) => d <= metres) ?? CALLED_DISTANCES[0];
}

/** Metres from the end of note i to the next one (or the finish). */
export function gapAfter(pacenotes, i) {
  const { notes, length } = pacenotes;
  const note = notes[i];
  return Math.max(0, (notes[i + 1]?.s ?? length) - (note.s + note.len));
}

/** What's called after note i: 'into', 'and', a distance, or the finish. */
export function gapLabel(pacenotes, i) {
  const gap = gapAfter(pacenotes, i);
  const last = i === pacenotes.notes.length - 1;
  if (last) return gap < AND_M ? 'finish' : `${calledDistance(shortDistanceValue(gap))} finish`;
  if (gap < INTO_M) return 'into';
  if (gap < AND_M) return 'and';
  return String(calledDistance(shortDistanceValue(gap)));
}

/** One line, e.g. 'L4 at junction 100'. */
export const callText = (pacenotes, i) => {
  const note = pacenotes.notes[i];
  return `${noteLabel(note)}${note.junction ? ' at junction' : ''} ${gapLabel(pacenotes, i)}`;
};
