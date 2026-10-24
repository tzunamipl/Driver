// Breakable lamps: a hard enough nose hit breaks the head lamp on that side,
// a tail hit the tail lamp; a square hit near the middle can take both.
// Sides are indexed by the chassis-local x of the lamp: 0 = +x, 1 = -x
// (headlights.js darkens the lens, flare and that side's share of the ground pool).

// Impact speed (m/s, along the contact normal) that breaks the lamp on the hit side.
const BREAK_MS = 5;
// Harder than this within CENTRE_BAND_M of the centre line breaks both lamps of that end.
const BOTH_MS = 9;
const CENTRE_BAND_M = 0.35;

export function createLampDamage() {
  const broken = { head: [false, false], tail: [false, false] };

  /** `end`: 1 nose, -1 tail; `localX`: chassis-local x of the contact; `speedMs` along the normal. */
  function hit(end, localX, speedMs) {
    if (!end || speedMs < BREAK_MS) return;
    const lamps = end > 0 ? broken.head : broken.tail;
    if (speedMs >= BOTH_MS && Math.abs(localX) < CENTRE_BAND_M) {
      lamps[0] = lamps[1] = true;
      return;
    }
    lamps[localX >= 0 ? 0 : 1] = true;
  }

  function repair() {
    broken.head.fill(false);
    broken.tail.fill(false);
  }

  function getState() {
    return { head: [...broken.head], tail: [...broken.tail] };
  }

  function setState(state) {
    for (const kind of ['head', 'tail']) {
      const sides = state?.[kind];
      if (Array.isArray(sides)) sides.slice(0, 2).forEach((b, i) => (broken[kind][i] = b === true));
    }
  }

  return { broken, hit, repair, getState, setState };
}
