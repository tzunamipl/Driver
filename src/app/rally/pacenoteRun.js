// Which pacenotes are on screen on a live stage. Each note is shown from LEAD_S_PER_KMH x speed
// before its corner to its apex. The car's distance along the stage is taken from the notes' own
// points (show, corner start, apex - ordered by s): one is passed when the car comes within PASS_M
// of it, and the car is the straight-line distance short of the next. A few points ahead are
// checked too, so a cut or a reset doesn't stall the list.

const PASS_M = 12;
const LOOKAHEAD = 6;
const LEAD_S_PER_KMH = 1.1; // shown this many metres before the corner per km/h, i.e. 130 km/h -> 143 m
const MIN_LEAD_M = 30; // still shown in time when crawling or at the start

/**
 * @param {{length: number, notes: object[]}} pacenotes - pacenoteCalls.js format.
 * @param {{fromLatLon: (lat: number, lon: number) => {x: number, z: number}}} viewFrame
 */
export function createPacenoteRun(pacenotes, viewFrame) {
  const { notes } = pacenotes;
  const anchors = notes.flatMap((note) => [note.show, note, note.apex]).sort((p, q) => p.s - q.s);
  let next = 0; // anchors before this one are passed
  let located = false;
  let carS = 0;
  let lead = MIN_LEAD_M;
  const at = (k) => viewFrame.fromLatLon(anchors[k].lat, anchors[k].lon);

  /** Mid-stage (resumed): past the nearest anchor, and the one after it once the car is beyond it. */
  function locate(pos) {
    let best = 0;
    let bestDist = Infinity;
    anchors.forEach((_, k) => {
      const p = at(k);
      const d = Math.hypot(p.x - pos.x, p.z - pos.z);
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    });
    const p = at(best);
    const q = anchors[best + 1] ? at(best + 1) : null;
    next = q && (pos.x - p.x) * (q.x - p.x) + (pos.z - p.z) * (q.z - p.z) > 0 ? best + 1 : best;
  }

  return {
    /** Per frame while the stage is live; `fromStart` = the run hasn't left the start yet, speed in m/s. */
    update(pos, fromStart, speed) {
      if (!located) {
        located = true;
        if (!fromStart) locate(pos);
      }
      for (let k = next; k < Math.min(anchors.length, next + LOOKAHEAD + 1); k++) {
        const p = at(k);
        if (Math.hypot(p.x - pos.x, p.z - pos.z) < PASS_M) next = k + 1;
      }
      const passedS = next > 0 ? anchors[next - 1].s : 0;
      if (next < anchors.length) {
        const p = at(next);
        carS = Math.max(passedS, anchors[next].s - Math.hypot(p.x - pos.x, p.z - pos.z));
      } else carS = passedS;
      lead = Math.max(MIN_LEAD_M, speed * 3.6 * LEAD_S_PER_KMH);
    },
    /** Indices of the notes to show (within the lead and apex not yet reached), the coming one first. */
    shown() {
      const on = [];
      notes.forEach((note, i) => {
        if (note.s - carS <= lead && note.apex.s > carS) on.push(i);
      });
      return on;
    },
  };
}
