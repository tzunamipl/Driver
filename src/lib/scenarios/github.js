// Commits scenario files to GitHub from the browser with the player's own token
// (classic, `public_repo` scope): to a branch of their fork of the scenarios repo,
// or of the repo itself when they own it. One commit per save, via the Git Data API.

const API = 'https://api.github.com';
const FORK_READY_TIMEOUT_MS = 30_000;
const FORK_POLL_MS = 1500;

export const TOKEN_HELP_URL = 'https://github.com/settings/tokens/new?scopes=public_repo&description=Driver%20scenario%20editor';

async function gh(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === 'GET' && res.status === 404) return null;
  if (!res.ok) {
    const message = (await res.json().catch(() => null))?.message ?? res.statusText;
    if (res.status === 401) throw new Error('GitHub token rejected');
    throw new Error(`GitHub ${res.status}: ${message}`);
  }
  return res.status === 204 ? null : res.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Player name -> branch name. */
export function branchNameFor(name) {
  const slug = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'player';
}

/** GitHub login behind the token. */
export async function getLogin(token) {
  return (await gh(token, 'GET', '/user')).login;
}

/** The repo to commit to: upstream if the token owns it, else the token's fork (created / synced). */
async function writableRepo(token, upstream, login) {
  if (login.toLowerCase() === upstream.owner.toLowerCase()) return { owner: upstream.owner, repo: upstream.repo };
  // Returns the existing fork when there is one.
  const fork = await gh(token, 'POST', `/repos/${upstream.owner}/${upstream.repo}/forks`, { default_branch_only: true });
  const repo = { owner: fork.owner.login, repo: fork.name, defaultBranch: fork.default_branch };
  const deadline = Date.now() + FORK_READY_TIMEOUT_MS;
  while (!(await gh(token, 'GET', `/repos/${repo.owner}/${repo.repo}/git/ref/heads/${repo.defaultBranch}`))) {
    if (Date.now() > deadline) throw new Error('GitHub is still creating your fork, try again in a minute');
    await sleep(FORK_POLL_MS);
  }
  // New branches start from upstream's latest; a conflict just leaves the fork as it was.
  await gh(token, 'POST', `/repos/${repo.owner}/${repo.repo}/merge-upstream`, { branch: repo.defaultBranch }).catch(() => {});
  return repo;
}

async function readText(token, { owner, repo }, path, ref) {
  const file = await gh(token, 'GET', `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
  if (!file?.content) return null;
  const bytes = Uint8Array.from(atob(file.content.replace(/\n/g, '')), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Commits files to `branch` (created from the repo's default branch if missing).
 * @param {object} opts
 * @param {string} opts.token
 * @param {{owner: string, repo: string}} opts.upstream - the official scenarios repo.
 * @param {string} opts.branch
 * @param {string} opts.message
 * @param {(readJson: (path: string) => Promise<any>) => Promise<{path: string, content: string}[]>} opts.buildFiles
 *   - gets the branch's current files, e.g. to merge an index.
 * @returns {Promise<{owner: string, repo: string, branch: string, sha: string}>}
 */
export async function commitFiles({ token, upstream, branch, message, buildFiles }) {
  const login = await getLogin(token);
  const repo = await writableRepo(token, upstream, login);
  const repoPath = `/repos/${repo.owner}/${repo.repo}`;

  let head = (await gh(token, 'GET', `${repoPath}/git/ref/heads/${branch}`))?.object.sha;
  if (!head) {
    const defaultBranch = repo.defaultBranch ?? (await gh(token, 'GET', repoPath)).default_branch;
    head = (await gh(token, 'GET', `${repoPath}/git/ref/heads/${defaultBranch}`)).object.sha;
    await gh(token, 'POST', `${repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha: head });
  }

  const files = await buildFiles(async (path) => {
    const text = await readText(token, repo, path, head);
    return text == null ? null : JSON.parse(text);
  });
  const baseTree = (await gh(token, 'GET', `${repoPath}/git/commits/${head}`)).tree.sha;
  const tree = await gh(token, 'POST', `${repoPath}/git/trees`, {
    base_tree: baseTree,
    tree: files.map(({ path, content }) => ({ path, mode: '100644', type: 'blob', content })),
  });
  const commit = await gh(token, 'POST', `${repoPath}/git/commits`, { message, tree: tree.sha, parents: [head] });
  await gh(token, 'PATCH', `${repoPath}/git/refs/heads/${branch}`, { sha: commit.sha });
  return { owner: repo.owner, repo: repo.repo, branch, sha: commit.sha };
}
