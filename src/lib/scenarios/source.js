// Scenario sources: a GitHub repo + branch, written `owner/repo@branch`. The branch is
// resolved to a commit first, so files come from raw.githubusercontent.com by sha and a
// just-pushed change isn't hidden behind the branch URL's cache. GitHub API reads ask the worker
// (worker/) first: anonymous browser calls get only 60 an hour; GitHub directly when it fails.

import { SCENARIO_FORMAT, LEADERBOARD_URL } from '../../config.js';

const SOURCE_RE = /^([\w.-]+)\/([\w.-]+)(?:@(.+))?$/;

/** 'owner/repo@branch' (branch defaults to main) -> { owner, repo, ref }, or null. */
export function parseSource(text) {
  const match = SOURCE_RE.exec(String(text ?? '').trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2], ref: match[3] ?? 'main' };
}

export const formatSource = ({ owner, repo, ref }) => `${owner}/${repo}@${ref}`;

const notFound = (source) => Object.assign(new Error(`${formatSource(source)} not found`), { notFound: true });

function rateLimitError(res) {
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const at = reset ? ` at ${new Date(reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ' later';
  return new Error(`GitHub rate limit reached, try again${at}`);
}

/** Anonymous GitHub API GET -> JSON (or text for a non-JSON `accept`). */
export async function githubApi(path, accept = 'application/vnd.github+json') {
  const res = await fetch(`https://api.github.com${path}`, { headers: { Accept: accept } });
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') throw rateLimitError(res);
  if (!res.ok) throw Object.assign(new Error(`GitHub: ${res.status}`), { status: res.status });
  return accept.endsWith('json') ? res.json() : res.text();
}

async function workerApi(path) {
  const res = await fetch(`${LEADERBOARD_URL}${path}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `${res.status}`);
  return body;
}

/** Worker GET -> JSON; `fromGithub()` instead when there is no worker or it fails (down, older deploy). */
export async function viaWorkerOr(path, fromGithub) {
  if (LEADERBOARD_URL) {
    try {
      return await workerApi(path);
    } catch (err) {
      console.warn(`Scenarios worker ${path} failed (${err.message}), asking GitHub directly`);
    }
  }
  return fromGithub();
}

async function resolveSha(source) {
  const { owner, repo, ref } = source;
  const { sha } = await viaWorkerOr(`/scenarios/commit?${new URLSearchParams({ owner, repo, ref })}`, async () => {
    try {
      return { sha: (await githubApi(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, 'application/vnd.github.sha')).trim() };
    } catch (err) {
      if (err.status === 404 || err.status === 422) return { sha: null };
      throw err;
    }
  });
  if (!sha) throw notFound(source);
  return sha;
}

/**
 * Pins `source` to its current commit. Returns { source, sha, readJson(path) }, where
 * readJson resolves null for a missing file and throws on a newer scenario format.
 * A missing branch throws an error with `notFound: true`.
 * @param {string} [knownSha] - the branch's commit when already known (skips the lookup).
 */
export async function openSource(source, knownSha) {
  const { owner, repo, ref } = source;
  const sha = knownSha ?? (await resolveSha(source));
  return {
    source,
    sha,
    async readJson(path) {
      const file = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${path}`);
      if (file.status === 404) return null;
      if (!file.ok) throw new Error(`${path}: ${file.status}`);
      const json = await file.json();
      if ((json?.format ?? 0) > SCENARIO_FORMAT) throw new Error(`${path} needs a newer game version`);
      return json;
    },
  };
}
