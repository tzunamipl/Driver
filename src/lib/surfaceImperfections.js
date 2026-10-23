// Deterministic small-scale ground bumps under the tyres (see a compound's
// imperfectionCm). 1 m squares of random height with rounded edges, keyed by
// network-frame metres, so the same spot always has the same bump, for every
// player and after origin shifts.

// Step layers (cell size m) and weights: a coarse layer plus the 1 m one.
const STEP_M = 1;
const OCTAVES = [
  { cell: STEP_M * 3, weight: 0.65 },
  { cell: STEP_M, weight: 0.35 },
];
// Half-width of the rounded edge, as a fraction of the cell; the rest stays flat.
const EDGE = 0.2;
const SEED = 0x5f3759df;

function hash2(ix, iz, salt) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ salt;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// 0..1 between two cell centres: flat near each centre, smoothstep across the edge.
function edgeBlend(f) {
  const t = Math.min(1, Math.max(0, (f - 0.5 + EDGE) / (2 * EDGE)));
  return t * t * (3 - 2 * t);
}

/** Bump height (m, centred on 0, peak-to-peak <= amplitudeM) at network-frame (x, z). */
export function sampleImperfection(x, z, amplitudeM) {
  let height = 0;
  for (let o = 0; o < OCTAVES.length; o++) {
    const { cell, weight } = OCTAVES[o];
    // Grid of cell centres: (ix, iz) is the centre at or before the point.
    const gx = x / cell - 0.5;
    const gz = z / cell - 0.5;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const sx = edgeBlend(gx - ix);
    const sz = edgeBlend(gz - iz);
    const salt = SEED + o * 0x9e3779b9;
    const a = hash2(ix, iz, salt);
    const b = hash2(ix + 1, iz, salt);
    const c = hash2(ix, iz + 1, salt);
    const d = hash2(ix + 1, iz + 1, salt);
    height += weight * (a + (b - a) * sx + (c - a + (a - b - c + d) * sx) * sz);
  }
  return (height - 0.5) * amplitudeM;
}
