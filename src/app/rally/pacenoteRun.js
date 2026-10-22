// Which pacenotes are on screen on a live stage. Each note is shown from its `show` point to its
// `apex`; those points, ordered along the stage, are events passed when the car comes within
// PASS_M of one. A few events ahead are checked too, so a cut or a reset doesn't stall the list.

const PASS_M = 12;
const LOOKAHEAD = 4;

/**
 * @param {{length: number, notes: object[]}} pacenotes - pacenoteCalls.js format.
 * @param {{fromLatLon: (lat: number, lon: number) => {x: number, z: number}}} viewFrame
 */
export function createPacenoteRun(pacenotes, viewFrame) {
  const events = pacenotes.notes
    .flatMap((note, i) => [
      { note: i, show: true, point: note.show },
      { note: i, show: false, point: note.apex },
    ])
    // At equal s a note's own show comes first; otherwise hide before show, so notes don't overlap needlessly.
    .sort((p, q) => p.point.s - q.point.s || (p.note === q.note ? q.show - p.show : p.show - q.show));
  let next = 0; // events before this one are passed
  let located = false;
  const at = (k) => viewFrame.fromLatLon(events[k].point.lat, events[k].point.lon);

  /** Mid-stage (resumed): past the nearest event, and the one after it once the car is beyond it. */
  function locate(pos) {
    let best = 0;
    let bestDist = Infinity;
    events.forEach((_, k) => {
      const p = at(k);
      const d = Math.hypot(p.x - pos.x, p.z - pos.z);
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    });
    const p = at(best);
    const q = events[best + 1] ? at(best + 1) : null;
    next = q && (pos.x - p.x) * (q.x - p.x) + (pos.z - p.z) * (q.z - p.z) > 0 ? best + 1 : best;
  }

  return {
    /** Per frame while the stage is live; `fromStart` = the run hasn't left the start yet. */
    update(pos, fromStart) {
      if (!located) {
        located = true;
        if (!fromStart) locate(pos);
      }
      for (let k = next; k < Math.min(events.length, next + LOOKAHEAD + 1); k++) {
        const p = at(k);
        if (Math.hypot(p.x - pos.x, p.z - pos.z) < PASS_M) next = k + 1;
      }
    },
    /** Indices of the notes to show (shown and apex not yet reached), the coming one first. */
    shown() {
      const on = new Set();
      for (let k = 0; k < next; k++) {
        if (events[k].show) on.add(events[k].note);
        else on.delete(events[k].note);
      }
      return [...on].sort((p, q) => p - q);
    },
  };
}
