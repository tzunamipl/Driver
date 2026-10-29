// The player's best stage times on this device, any car: { 'source|stageId': { totalMs, splits } };
// and their run history per stage / rally: { key: [{ totalMs, vehicle, at }] }, fastest first.

import { RALLY_BEST_STORAGE_KEY, RALLY_RUNS_STORAGE_KEY } from '../../config.js';

// Runs kept per key: each car's best + the fastest RUNS_KEPT, all the picker's personal list can show.
export const RUNS_KEPT = 20;

export const localBestKey = (source, stageId) => `${source}|${stageId}`;
export const localRallyKey = (source, rallyId) => `${source}|rally:${rallyId}`;

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? {};
  } catch {
    return {};
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: lasts this session only.
  }
}

export const readLocalBests = () => readJson(RALLY_BEST_STORAGE_KEY);
export const writeLocalBests = (all) => writeJson(RALLY_BEST_STORAGE_KEY, all);

/** Runs of a stage / rally key, fastest first. */
export const readLocalRuns = (key) => readJson(RALLY_RUNS_STORAGE_KEY)[key] ?? [];

/** @param {{totalMs: number, vehicle: string}} run */
export function addLocalRun(key, { totalMs, vehicle }) {
  const all = readJson(RALLY_RUNS_STORAGE_KEY);
  const runs = [...(all[key] ?? []), { totalMs, vehicle, at: new Date().toISOString() }].sort((a, b) => a.totalMs - b.totalMs);
  const cars = new Set();
  all[key] = runs.filter((run, i) => {
    const carBest = !cars.has(run.vehicle);
    cars.add(run.vehicle);
    return carBest || i < RUNS_KEPT;
  });
  writeJson(RALLY_RUNS_STORAGE_KEY, all);
}
