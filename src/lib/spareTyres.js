// Rally spare wheels: picked per vehicle (lib/garage.js), carried as chassis mass, each
// swaps in for one flat (car.js fitSpareTyre). On a live stage the swap costs time.

export const MAX_SPARE_TYRES = 2;
export const DEFAULT_SPARE_TYRES = 1;
export const SPARE_TYRE_KG = 15;
export const SPARE_FIT_PENALTY_MS = 5 * 60_000;

export const clampSpareTyres = (n) => (Number.isInteger(n) ? Math.min(MAX_SPARE_TYRES, Math.max(0, n)) : DEFAULT_SPARE_TYRES);
