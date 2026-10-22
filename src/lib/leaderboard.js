// Online stage leaderboards: each player's best time per vehicle on official stages, through the
// leaderboard worker (worker/), which keeps them in a GitHub data repo. Off when the
// build has no VITE_LEADERBOARD_URL.

import { LEADERBOARD_URL } from '../config.js';

const BOARD_CACHE_MS = 60_000;

export const leaderboardEnabled = () => !!LEADERBOARD_URL;

const boardCache = new Map(); // stage -> { at, board: Promise }

function cacheBoard(stage, board) {
  board.catch(() => boardCache.get(stage)?.board === board && boardCache.delete(stage));
  boardCache.set(stage, { at: performance.now(), board });
}

async function api(path, init) {
  const res = await fetch(`${LEADERBOARD_URL}${path}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Leaderboard ${res.status}`);
  return body;
}

/** The player's id on the board (worker/src/index.js playerHash). */
export async function playerHash(playerId) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(playerId));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/**
 * @param {{stage: string, sha: string, playerId: string, name: string, vehicle: string,
 *   totalMs: number, splits: number[], penaltyMs: number}} run - stage = its file key, sha = scenarios commit it was loaded from.
 * @returns {Promise<{board: {entries: object[]}, rank: number | null, improved: boolean}>}
 */
export async function submitStageTime(run) {
  const result = await api('/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...run, version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '' }),
  });
  cacheBoard(run.stage, Promise.resolve(result.board));
  return result;
}

/**
 * An official stage's board, fastest first; cached a minute so re-picking a stage doesn't refetch.
 * @param {string} stage - its file key.
 * @returns {Promise<{entries: {player: string, name: string, vehicle: string, totalMs: number}[]}>}
 */
export function fetchStageBoard(stage) {
  const hit = boardCache.get(stage);
  if (hit && performance.now() - hit.at < BOARD_CACHE_MS) return hit.board;
  cacheBoard(stage, api(`/board?stage=${encodeURIComponent(stage)}`).then((res) => res.board));
  return boardCache.get(stage).board;
}
