// Scenario sources: a GitHub repo + branch, written `owner/repo@branch`. The branch is
// resolved to a commit first, so files come from raw.githubusercontent.com by sha and a
// just-pushed change isn't hidden behind the branch URL's cache.

import { SCENARIO_FORMAT } from '../../config.js';

const SOURCE_RE = /^([\w.-]+)\/([\w.-]+)(?:@(.+))?$/;

/** 'owner/repo@branch' (branch defaults to main) -> { owner, repo, ref }, or null. */
export function parseSource(text) {
  const match = SOURCE_RE.exec(String(text ?? '').trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2], ref: match[3] ?? 'main' };
}

export const formatSource = ({ owner, repo, ref }) => `${owner}/${repo}@${ref}`;

async function resolveSha(source, token) {
  const { owner, repo, ref } = source;
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
    headers: { Accept: 'application/vnd.github.sha', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 404 || res.status === 422) throw new Error(`${formatSource(source)} not found`);
  if (!res.ok) throw new Error(`GitHub: ${res.status}`);
  return (await res.text()).trim();
}

/**
 * Pins `source` to its current commit. Returns { source, sha, readJson(path) }, where
 * readJson resolves null for a missing file and throws on a newer scenario format.
 * @param {string} [token] - GitHub token, for its higher API rate limit.
 * @param {string} [knownSha] - the branch's commit when already known (skips the lookup).
 */
export async function openSource(source, token, knownSha) {
  const { owner, repo, ref } = source;
  const sha = knownSha ?? (await resolveSha(source, token));
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
