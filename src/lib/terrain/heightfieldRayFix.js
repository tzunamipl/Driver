import * as CANNON from 'cannon-es';

// cannon-es bounds a cell's height by only two diagonal corners (unordered), so
// short rays (wheel suspension) whose hit lies outside that range get culled and
// pass straight through uneven ground. Use all four corners instead.
CANNON.Heightfield.prototype.getAabbAtIndex = function (xi, yi, { lowerBound, upperBound }) {
  const data = this.data;
  const w = this.elementSize;
  const a = data[xi][yi];
  const b = data[xi + 1][yi];
  const c = data[xi][yi + 1];
  const d = data[xi + 1][yi + 1];
  lowerBound.set(xi * w, yi * w, Math.min(a, b, c, d));
  upperBound.set((xi + 1) * w, (yi + 1) * w, Math.max(a, b, c, d));
};
