// What scenario sources exist: official = the scenarios repo's default branch; players =
// its other branches (where the editor saves) plus the non-default branches of its forks.
// Branch listings carry their commit, so sources open without another lookup. The worker
// (worker/) lists them first, past GitHub's anonymous rate limit; GitHub directly when it fails.

import { SCENARIOS_REPO } from '../../config.js';
import { openSource, githubApi, viaWorkerOr } from './source.js';

const branchesOf = (owner, repo) => githubApi(`/repos/${owner}/${repo}/branches?per_page=100`);

/** Straight from GitHub; mirrors the worker's loadSources. */
async function listFromGithub() {
  const { owner, repo } = SCENARIOS_REPO;
  const [info, branches, forks] = await Promise.all([
    githubApi(`/repos/${owner}/${repo}`),
    branchesOf(owner, repo),
    githubApi(`/repos/${owner}/${repo}/forks?per_page=100`).catch(() => []),
  ]);
  const sources = [];
  for (const b of branches) {
    const official = b.name === info.default_branch;
    sources.push({ label: official ? 'Official' : b.name, official, source: { owner, repo, ref: b.name }, sha: b.commit.sha });
  }
  const forkBranches = await Promise.all(
    forks.map((fork) =>
      branchesOf(fork.owner.login, fork.name)
        .then((list) => list.filter((b) => b.name !== fork.default_branch).map((b) => ({ fork, b })))
        .catch(() => [])
    )
  );
  for (const { fork, b } of forkBranches.flat()) {
    const label = b.name.toLowerCase() === fork.owner.login.toLowerCase() ? fork.owner.login : `${fork.owner.login} · ${b.name}`;
    sources.push({ label, official: false, source: { owner: fork.owner.login, repo: fork.name, ref: b.name }, sha: b.commit.sha });
  }
  return sources;
}

/**
 * Official source plus player sources: [{ label, official, source: {owner, repo, ref}, sha }].
 * Forks are listed too; their default branch is just a copy of official, so it's skipped.
 */
export async function listSources() {
  const { sources } = await viaWorkerOr('/scenarios/sources', async () => ({ sources: await listFromGithub() }));
  const official = sources.filter((s) => s.official);
  const players = sources.filter((s) => !s.official).sort((a, b) => a.label.localeCompare(b.label));
  return [...official, ...players];
}

/** Opens a listed source at its listed commit (see source.js openSource). */
export const openListed = ({ source, sha }) => openSource(source, sha);
