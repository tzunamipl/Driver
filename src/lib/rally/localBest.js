// The player's best stage times on this device, any car: { 'source|stageId': { totalMs, splits } }.

import { RALLY_BEST_STORAGE_KEY } from '../../config.js';

export const localBestKey = (source, stageId) => `${source}|${stageId}`;

export function readLocalBests() {
  try {
    return JSON.parse(localStorage.getItem(RALLY_BEST_STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

export function writeLocalBests(all) {
  try {
    localStorage.setItem(RALLY_BEST_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: bests last this session only.
  }
}
