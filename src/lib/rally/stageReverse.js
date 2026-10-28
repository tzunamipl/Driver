// A stage's two versions: forward (as authored) and reverse (points in reverse order with start <-> finish
// and time control <-> stop swapped - the old stop stands just past the old finish = the new start -, headings
// turned round). Passage controls and course objects can be in one version only (`only`: 'forward' | 'reverse',
// none = both). A reverse leg is straight when the forward leg between the same two points is, or its end point
// has `straightReverse`. A reverse stage's id is its file key + REVERSE_SUFFIX (own local bests and online
// board). No imports: the worker uses it too.

export const REVERSE_SUFFIX = '~reverse';
export const VERSIONS = ['forward', 'reverse'];

const SWAP = { start: 'finish', finish: 'start', timeControl: 'stop', stop: 'timeControl' };
const ROUTE_TYPES = new Set(['start', 'split', 'passageControl', 'finish']); // as pacenotes.js route waypoints

export const reverseKey = (key) => `${key}${REVERSE_SUFFIX}`;

/** Stage id -> { key (the file's), reverse }. */
export function splitReverseKey(id) {
  const reverse = typeof id === 'string' && id.endsWith(REVERSE_SUFFIX);
  return { key: reverse ? id.slice(0, -REVERSE_SUFFIX.length) : id, reverse };
}

/** A point type as driven in that version. */
export const drivenType = (type, reverse) => (reverse ? SWAP[type] ?? type : type);

/** Whether a stage point or course object is in that version. */
export const inVersion = (item, reverse) => item.only !== (reverse ? 'forward' : 'reverse');

/** Indices of a stage's points in that version, in its driving order. */
export function drivenOrder(points, reverse) {
  const order = [];
  points.forEach((p, i) => inVersion(p, reverse) && order.push(i));
  return reverse ? order.reverse() : order;
}

/** One point driven the other way, without leg flags; `defaultWidth(type)`: one at its old type's default width gets the new type's. */
export function reversePoint({ straight, straightReverse, only, ...p }, { defaultWidth } = {}) {
  const point = { ...p, type: drivenType(p.type, true) };
  if (Number.isFinite(p.heading)) point.heading = (p.heading + 180) % 360;
  if (defaultWidth && p.width === defaultWidth(p.type)) point.width = defaultWidth(point.type);
  return point;
}

/**
 * Stage points (rally.js items) as driven in one version, each leg flag in `straight` (on the leg's end point).
 * `ownReverseFlags: false`: only the reverse legs straight because of the forward ones.
 */
export function drivenStagePoints(points, { reverse = false, defaultWidth, ownReverseFlags = true } = {}) {
  const order = drivenOrder(points, reverse);
  if (!reverse) return order.map((i) => {
    const { straightReverse, only, ...p } = points[i];
    return p;
  });
  const forwardLegs = new Set(); // `${from},${to}` point indices of straight forward legs
  let prev = -1;
  for (const i of drivenOrder(points, false)) {
    if (!ROUTE_TYPES.has(points[i].type)) continue;
    if (prev >= 0 && points[i].straight) forwardLegs.add(`${prev},${i}`);
    prev = i;
  }
  prev = -1;
  return order.map((i) => {
    const point = reversePoint(points[i], { defaultWidth });
    if (!ROUTE_TYPES.has(points[i].type)) return point;
    if (prev >= 0 && ((ownReverseFlags && points[i].straightReverse) || forwardLegs.has(`${i},${prev}`))) point.straight = true;
    prev = i;
    return point;
  });
}
