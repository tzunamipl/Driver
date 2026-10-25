// Breakable lamps: a hard enough nose hit breaks the head lamp on that side,
// a tail hit the tail lamp; a square hit near the middle can take both.
// Sides are indexed by the chassis-local x of the lamp: 0 = +x, 1 = -x
// (headlights.js darkens the lens, flare and that side's share of the ground pool).
// A lamp taped up at a rally service (repair 'tape') works but breaks again from a lighter hit.

// Impact speed (m/s, along the contact normal) that breaks the lamp on the hit side.
const BREAK_MS = 5;
const TAPED_BREAK_MS = 2.5;
// Harder than this within CENTRE_BAND_M of the centre line breaks both lamps of that end.
const BOTH_MS = 9;
const CENTRE_BAND_M = 0.35;

export function createLampDamage() {
  const broken = { head: [false, false], tail: [false, false] };
  const taped = { head: [false, false], tail: [false, false] };

  function breakLamp(kind, side, speedMs) {
    if (speedMs >= (taped[kind][side] ? TAPED_BREAK_MS : BREAK_MS)) {
      broken[kind][side] = true;
      taped[kind][side] = false;
    }
  }

  /** `end`: 1 nose, -1 tail; `localX`: chassis-local x of the contact; `speedMs` along the normal. */
  function hit(end, localX, speedMs) {
    if (!end) return;
    const kind = end > 0 ? 'head' : 'tail';
    if (speedMs >= BOTH_MS && Math.abs(localX) < CENTRE_BAND_M) {
      breakLamp(kind, 0, speedMs);
      breakLamp(kind, 1, speedMs);
      return;
    }
    breakLamp(kind, localX >= 0 ? 0 : 1, speedMs);
  }

  /** Every lamp, or only `kind` ('head' | 'tail') on `side`, as new. */
  function repair(kind, side) {
    if (kind) {
      broken[kind][side] = taped[kind][side] = false;
      return;
    }
    for (const lamps of [broken.head, broken.tail, taped.head, taped.tail]) lamps.fill(false);
  }

  /** Broken lamp taped up: lit again, but fragile. */
  function tape(kind, side) {
    if (!broken[kind][side]) return;
    broken[kind][side] = false;
    taped[kind][side] = true;
  }

  function getState() {
    return { head: [...broken.head], tail: [...broken.tail], taped: { head: [...taped.head], tail: [...taped.tail] } };
  }

  function setState(state) {
    for (const kind of ['head', 'tail']) {
      const sides = state?.[kind];
      if (Array.isArray(sides)) sides.slice(0, 2).forEach((b, i) => (broken[kind][i] = b === true));
      const tapedSides = state?.taped?.[kind];
      taped[kind].fill(false);
      if (Array.isArray(tapedSides)) tapedSides.slice(0, 2).forEach((b, i) => (taped[kind][i] = b === true && !broken[kind][i]));
    }
  }

  return { broken, taped, hit, repair, tape, getState, setState };
}
