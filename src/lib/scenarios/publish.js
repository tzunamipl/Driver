// Editor saves through the worker (worker/): it commits the file to the player's branch of the
// scenarios repo (named after the player, shared by everyone using that name) and opens a PR.
// Off when the build has no VITE_LEADERBOARD_URL.

import { LEADERBOARD_URL } from '../../config.js';

export const publishEnabled = () => !!LEADERBOARD_URL;

/** Player name -> branch name. */
export function branchNameFor(name) {
  const slug = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'player';
}

/**
 * @param {{branch: string, folder: string, kindFolder: string, key: string, content: string}} save
 * @returns {Promise<{owner: string, repo: string, branch: string, sha: string, unchanged: boolean, pr: string | null}>}
 *   unchanged: the file already matched the branch (or official, then `branch` is official), so nothing was committed.
 */
export async function publishScenario(save) {
  const res = await fetch(`${LEADERBOARD_URL}/scenarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(save),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `Save failed: ${res.status}`);
  return body;
}
