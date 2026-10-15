// Deterministic small-scale ground bumps under the tyres (see a compound's
// imperfectionCm). Value noise keyed by network-frame metres, so the same
// spot always has the same bump, for every player and after origin shifts.

// Bump wavelengths (m) and weights: a long swell plus short chatter. Shorter
// than ~0.2 m would be bridged by the contact patch anyway.
const OCTAVES = [
  { cell: 0.9, weight: 0.65 },
  { cell: 0.3, weight: 0.35 },
];
const SEED = 0x5f3759df;

function hash2(ix, iz, salt) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ salt;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);
const smoothDeriv = (t) => 6 * t * (1 - t);

/**
 * Bump height (m, centred on 0, peak-to-peak <= amplitudeM) and its slope at
 * network-frame (x, z), written into out { height, dhdx, dhdz }.
 */
export function sampleImperfection(x, z, amplitudeM, out) {
  let height = 0;
  let dhdx = 0;
  let dhdz = 0;
  for (let o = 0; o < OCTAVES.length; o++) {
    const { cell, weight } = OCTAVES[o];
    const gx = x / cell;
    const gz = z / cell;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const salt = SEED + o * 0x9e3779b9;
    const a = hash2(ix, iz, salt);
    const b = hash2(ix + 1, iz, salt);
    const c = hash2(ix, iz + 1, salt);
    const d = hash2(ix + 1, iz + 1, salt);
    const sx = smooth(fx);
    const sz = smooth(fz);
    const k1 = b - a;
    const k2 = c - a;
    const k3 = a - b - c + d;
    height += weight * (a + k1 * sx + k2 * sz + k3 * sx * sz);
    dhdx += (weight * (k1 + k3 * sz) * smoothDeriv(fx)) / cell;
    dhdz += (weight * (k2 + k3 * sx) * smoothDeriv(fz)) / cell;
  }
  out.height = (height - 0.5) * amplitudeM;
  out.dhdx = dhdx * amplitudeM;
  out.dhdz = dhdz * amplitudeM;
  return out;
}
