// Driver API: checks stage times against the official stage files and keeps each player's best
// per vehicle in D1 (binding DB, schema in migrations/); commits editor saves to a player's
// branch of the scenarios repo, with a PR into the official branch. The tokens stay here.
//   GET  /board?stage=<country/region/id>  -> { board }  (stage ids + `~reverse` = driven the other way, own board)
//   POST /results { stage, sha, playerId, name, vehicle, totalMs, splits, penaltyMs, version }
//        -> { board, rank, improved }
//   POST /scenarios { branch, folder, kindFolder, key, content } -> { owner, repo, branch, sha, unchanged, pr }
//   GET  /scenarios/sources -> { sources: [{ label, official, source: { owner, repo, ref }, sha }] }
//   GET  /scenarios/commit?owner=&repo=&ref= -> { sha }  (null = no such repo / branch)

import { currentVehicleId } from '../../src/lib/vehicles/legacyIds.js';
import { REVERSE_SUFFIX, splitReverseKey, drivenStagePoints } from '../../src/lib/rally/stageReverse.js';

const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
const STAGE_KEY_RE = new RegExp(`^(?:${SLUG}/${SLUG}/)?${SLUG}$`); // bare `id` = flat layout from before countries
const STAGE_ID_RE = new RegExp(`^(?:${SLUG}/${SLUG}/)?${SLUG}(?:${REVERSE_SUFFIX})?$`);
const PLAYER_ID_RE = /^[0-9a-f-]{8,64}$/i;
const VEHICLE_RE = /^[\w-]{1,40}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^[\w.-]{1,20}$/;
const MAX_AVG_SPEED_MPS = 90; // straight-line average between gates; quicker is not a real run
const MAX_TIME_MS = 6 * 3600_000;
const NAME_MAX = 24;
const MAX_ENTRIES = 1000;
const PUT_RETRIES = 3;
const STAGE_CACHE_S = 300;
const BRANCH_RE = new RegExp(`^${SLUG}$`);
const BRANCH_MAX = 40;
const SCENARIO_MAX_BYTES = 256 * 1024;
// `<mode folder>/<kind folder>` the editor may save -> its index.json list and commit label.
const SCENARIO_KINDS = {
  'rally/stages': { indexKey: 'stages', label: 'Stage' },
  'rally/rallies': { indexKey: 'rallies', label: 'Rally' },
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Mirrors src/lib/scenarios/paths.js filePath.
const stageFilePath = (key) => {
  const parts = key.split('/');
  return parts.length === 1 ? `rally/stages/${key}.json` : `rally/${parts[0]}/${parts[1]}/stages/${parts[2]}.json`;
};

async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Public id on the board: the raw player id is also the MQTT identity. */
const playerHash = async (playerId) => (await sha256Hex(playerId)).slice(0, 16);

/** The stage file of a stage id, its points as driven in that version (timing checks and fingerprint follow them). */
async function fetchStage(env, id, ref) {
  const { key, reverse } = splitReverseKey(id);
  const res = await fetch(`https://raw.githubusercontent.com/${env.SCENARIOS_REPO}/${ref}/${stageFilePath(key)}`, {
    cf: { cacheTtl: STAGE_CACHE_S, cacheEverything: true },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, `Scenarios repo: ${res.status}`);
  const stage = await res.json();
  return { ...stage, points: drivenStagePoints(stage.points ?? [], { reverse }) };
}

/** Points that decide the timing; any edit to them starts the stage's board over. Heading and snap only when set, so older files keep theirs. */
const fingerprint = (stage) =>
  sha256Hex(
    JSON.stringify((stage.points ?? []).map((p) => [p.type, p.lat, p.lon, p.width ?? null, ...(p.heading != null ? [p.heading] : []), ...(p.snap === false ? ['free'] : [])]))
  ).then((h) => h.slice(0, 16));

function distanceM(a, b) {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Throws unless the times fit the stage: split count, order, and no faster than MAX_AVG_SPEED_MPS. */
function checkTimes(stage, { totalMs, splits, penaltyMs }) {
  const points = stage.points ?? [];
  const start = points.findIndex((p) => p.type === 'start');
  const finish = points.findIndex((p) => p.type === 'finish');
  if (start < 0 || finish < start) throw new HttpError(422, 'Stage has no start / finish');
  const driveMs = totalMs - penaltyMs;
  let dist = 0;
  let split = 0;
  let prevMs = 0;
  for (let i = start + 1; i <= finish; i++) {
    dist += distanceM(points[i - 1], points[i]);
    const ms = points[i].type === 'split' ? splits[split++] : points[i].type === 'finish' ? driveMs : null;
    if (ms == null) continue;
    if (!Number.isInteger(ms) || ms <= prevMs) throw new HttpError(422, 'Times out of order');
    if (ms < (dist / MAX_AVG_SPEED_MPS) * 1000) throw new HttpError(422, 'Time too short for the stage');
    prevMs = ms;
  }
  if (split !== splits.length) throw new HttpError(422, 'Split count does not match the stage');
}

function readSubmission(body) {
  const { stage, sha, playerId, name, vehicle, totalMs, splits, penaltyMs = 0, version = '' } = body ?? {};
  if (!STAGE_ID_RE.test(stage ?? '')) throw new HttpError(400, 'Bad stage');
  if (!SHA_RE.test(sha ?? '')) throw new HttpError(400, 'Bad sha');
  if (!PLAYER_ID_RE.test(playerId ?? '')) throw new HttpError(400, 'Bad playerId');
  if (!VEHICLE_RE.test(vehicle ?? '')) throw new HttpError(400, 'Bad vehicle');
  if (!VERSION_RE.test(version || '0')) throw new HttpError(400, 'Bad version');
  if (!Number.isInteger(totalMs) || totalMs <= 0 || totalMs > MAX_TIME_MS) throw new HttpError(400, 'Bad totalMs');
  // Penalties (jump start, field fixes, spare wheels) only add time, so any sum below the total is fine.
  if (!Number.isInteger(penaltyMs) || penaltyMs < 0 || penaltyMs >= totalMs) throw new HttpError(400, 'Bad penaltyMs');
  if (!Array.isArray(splits) || splits.length > 100) throw new HttpError(400, 'Bad splits');
  const cleanName = String(name ?? '').replace(/[\p{C}]/gu, '').trim().slice(0, NAME_MAX) || 'Player';
  return { stage, sha, playerId, name: cleanName, vehicle: currentVehicleId(vehicle), totalMs, splits, penaltyMs, version };
}

// ---------- GitHub ----------

const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

const github = (token, method, path, body) =>
  fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'driver-leaderboard',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

// ---------- Boards (D1) ----------

/** Drops the entries of a board set for another stage version (its points changed). */
const dropStaleEntries = (env, key, print) =>
  env.DB.prepare('DELETE FROM entries WHERE stage = ?1 AND EXISTS (SELECT 1 FROM boards WHERE stage = ?1 AND fingerprint != ?2)').bind(key, print);

const selectEntries = (env, key) =>
  env.DB.prepare(
    'SELECT player, name, vehicle, total_ms, splits, penalty_ms, at, version FROM entries WHERE stage = ? ORDER BY total_ms, at LIMIT ?'
  ).bind(key, MAX_ENTRIES);

const boardOf = (key, print, rows) => ({
  stage: key,
  fingerprint: print,
  entries: rows.map((r) => ({
    player: r.player,
    name: r.name,
    vehicle: r.vehicle,
    totalMs: r.total_ms,
    splits: JSON.parse(r.splits),
    penaltyMs: r.penalty_ms,
    at: r.at,
    version: r.version,
  })),
});

async function submit(env, sub) {
  const [atRun, atHead] = await Promise.all([fetchStage(env, sub.stage, sub.sha), fetchStage(env, sub.stage, env.SCENARIOS_BRANCH)]);
  if (!atRun || !atHead) throw new HttpError(404, 'Not an official stage');
  const print = await fingerprint(atHead);
  if ((await fingerprint(atRun)) !== print) throw new HttpError(409, 'Stage has changed since this run');
  checkTimes(atHead, sub);

  const player = await playerHash(sub.playerId);
  // One transaction: the entry is only replaced by a faster time, the board keeps the MAX_ENTRIES fastest.
  const [, , upsert, , read] = await env.DB.batch([
    dropStaleEntries(env, sub.stage, print),
    env.DB.prepare('INSERT INTO boards (stage, fingerprint) VALUES (?1, ?2) ON CONFLICT (stage) DO UPDATE SET fingerprint = excluded.fingerprint').bind(
      sub.stage,
      print
    ),
    env.DB.prepare(
      `INSERT INTO entries (stage, player, vehicle, name, total_ms, splits, penalty_ms, at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (stage, player, vehicle) DO UPDATE SET name = excluded.name, total_ms = excluded.total_ms, splits = excluded.splits,
         penalty_ms = excluded.penalty_ms, at = excluded.at, version = excluded.version
       WHERE excluded.total_ms < entries.total_ms`
    ).bind(sub.stage, player, sub.vehicle, sub.name, sub.totalMs, JSON.stringify(sub.splits), sub.penaltyMs, new Date().toISOString(), sub.version),
    env.DB.prepare(
      'DELETE FROM entries WHERE stage = ?1 AND rowid NOT IN (SELECT rowid FROM entries WHERE stage = ?1 ORDER BY total_ms, at LIMIT ?2)'
    ).bind(sub.stage, MAX_ENTRIES),
    selectEntries(env, sub.stage),
  ]);
  return { board: boardOf(sub.stage, print, read.results), improved: upsert.meta.changes > 0 };
}

async function getBoard(env, key) {
  if (!STAGE_ID_RE.test(key ?? '')) throw new HttpError(400, 'Bad stage');
  const head = await fetchStage(env, key, env.SCENARIOS_BRANCH);
  if (!head) throw new HttpError(404, 'Not an official stage');
  const print = await fingerprint(head);
  const [, read] = await env.DB.batch([dropStaleEntries(env, key, print), selectEntries(env, key)]);
  return boardOf(key, print, read.results);
}

// ---------- Scenario saves ----------

/** Scenarios repo call that throws on failure; GET 404 -> null. */
async function scenariosApi(env, method, path, body) {
  const res = await github(env.SCENARIOS_TOKEN, method, `/repos/${env.SCENARIOS_REPO}${path}`, body);
  if (method === 'GET' && res.status === 404) return null;
  if (!res.ok) {
    const message = (await res.json().catch(() => null))?.message ?? res.statusText;
    throw new HttpError(res.status === 422 || res.status === 409 ? 409 : 502, `Scenarios repo: ${message}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Branch commit, or null when it doesn't exist (matching-refs: no 404 for a missing branch). */
async function branchHead(env, branch) {
  const refs = await scenariosApi(env, 'GET', `/git/matching-refs/heads/${branch}`);
  return refs?.find((ref) => ref.ref === `refs/heads/${branch}`)?.object.sha ?? null;
}

function readScenarioSave(body, env) {
  const { branch, folder, kindFolder, key, content } = body ?? {};
  if (!BRANCH_RE.test(branch ?? '') || branch.length > BRANCH_MAX) throw new HttpError(400, 'Bad branch');
  if (branch === env.SCENARIOS_BRANCH) throw new HttpError(400, 'This player name is reserved, pick another one');
  const kind = SCENARIO_KINDS[`${folder}/${kindFolder}`];
  if (!kind) throw new HttpError(400, 'Bad kind');
  if (!STAGE_KEY_RE.test(key ?? '')) throw new HttpError(400, 'Bad key');
  if (typeof content !== 'string' || new TextEncoder().encode(content).length > SCENARIO_MAX_BYTES) throw new HttpError(400, 'Bad content');
  let json;
  try {
    json = JSON.parse(content);
  } catch {
    throw new HttpError(400, 'Content is not JSON');
  }
  const parts = key.split('/');
  const id = parts.at(-1);
  if (json?.id !== id || !Number.isInteger(json.format)) throw new HttpError(400, 'Content does not match the key');
  if (parts.length === 3 && (json.country !== parts[0] || json.region !== parts[1])) throw new HttpError(400, 'Content does not match the key');
  // Mirrors src/lib/scenarios/paths.js filePath.
  const path = parts.length === 1 ? `${folder}/${kindFolder}/${id}.json` : `${folder}/${parts[0]}/${parts[1]}/${kindFolder}/${id}.json`;
  return { branch, folder, kind, key, path, content, format: json.format, name: String(json.name ?? '').replace(/[\p{C}]/gu, '').slice(0, 80) };
}

/** One commit with the file + its index entry on the player's branch (made from the official one if missing). */
async function commitScenario(env, save) {
  const indexPath = `${save.folder}/index.json`;
  for (let attempt = 0; ; attempt++) {
    const branchSha = await branchHead(env, save.branch);
    const head = branchSha ?? (await branchHead(env, env.SCENARIOS_BRANCH));
    const indexFile = await scenariosApi(env, 'GET', `/contents/${indexPath}?ref=${head}`);
    const index = indexFile ? JSON.parse(fromBase64(indexFile.content)) : {};
    const keys = new Set(index[save.kind.indexKey] ?? []).add(save.key);
    const nextIndex = { ...index, format: Math.max(index.format ?? 0, save.format), [save.kind.indexKey]: [...keys].sort() };
    const baseTree = (await scenariosApi(env, 'GET', `/git/commits/${head}`)).tree.sha;
    const tree = await scenariosApi(env, 'POST', '/git/trees', {
      base_tree: baseTree,
      tree: [
        { path: save.path, mode: '100644', type: 'blob', content: save.content },
        { path: indexPath, mode: '100644', type: 'blob', content: `${JSON.stringify(nextIndex, null, 2)}\n` },
      ],
    });
    // Nothing new (e.g. an official file saved as is): no commit, and no empty branch.
    if (tree.sha === baseTree) return { sha: head, unchanged: true, exists: !!branchSha };
    const commit = await scenariosApi(env, 'POST', '/git/commits', {
      message: `${save.kind.label} ${save.key}: ${save.name} (${save.branch})`,
      tree: tree.sha,
      parents: [head],
    });
    try {
      // Not forced: a save that landed in between makes this fail, then it's redone on top.
      if (branchSha) await scenariosApi(env, 'PATCH', `/git/refs/heads/${save.branch}`, { sha: commit.sha });
      else await scenariosApi(env, 'POST', '/git/refs', { ref: `refs/heads/${save.branch}`, sha: commit.sha });
      return { sha: commit.sha, unchanged: false, exists: true };
    } catch (err) {
      if (err.status !== 409 || attempt >= PUT_RETRIES) throw err;
    }
  }
}

/** The branch's open PR into the official branch, opened on first save. */
async function ensurePullRequest(env, branch) {
  const owner = env.SCENARIOS_REPO.split('/')[0];
  const open = await scenariosApi(env, 'GET', `/pulls?state=open&head=${owner}:${branch}&base=${env.SCENARIOS_BRANCH}`);
  if (open?.length) return open[0].html_url;
  const pr = await scenariosApi(env, 'POST', '/pulls', {
    title: `Scenarios from ${branch}`,
    head: branch,
    base: env.SCENARIOS_BRANCH,
    body: `Saved from the in-game editor by player "${branch}".`,
  }).catch((err) => {
    // 422 "no commits between": the branch matches the official one (already merged).
    if (err.status === 409) return null;
    throw err;
  });
  return pr?.html_url ?? null;
}

async function saveScenario(env, save) {
  const { sha, unchanged, exists } = await commitScenario(env, save);
  const [owner, repo] = env.SCENARIOS_REPO.split('/');
  return { owner, repo, branch: exists ? save.branch : env.SCENARIOS_BRANCH, sha, unchanged, pr: exists ? await ensurePullRequest(env, save.branch) : null };
}

// ---------- Scenario sources ----------
// Read with the scenarios token (5000 requests / h, also reads public forks) instead of each
// browser's 60 / h anonymous limit, and kept a little while in the isolate.

const SOURCES_CACHE_MS = 60_000;
const COMMIT_CACHE_MS = 30_000;
const REPO_PART_RE = /^[\w.-]{1,100}$/;
const REF_RE = /^[\w./-]{1,100}$/;
const MEMO_MAX = 500;
const memo = new Map(); // key -> { at, value: Promise }

const isRemembered = (key, ttlMs) => Date.now() - (memo.get(key)?.at ?? -Infinity) < ttlMs;

function remembered(key, ttlMs, load) {
  if (isRemembered(key, ttlMs)) return memo.get(key).value;
  // Oldest first: callers choose the keys, so the cache can't grow without bound.
  while (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
  const value = load();
  value.catch(() => memo.get(key)?.value === value && memo.delete(key));
  memo.set(key, { at: Date.now(), value });
  return value;
}

/** Public GitHub read; 404 -> null. */
async function githubRead(env, path) {
  const res = await github(env.SCENARIOS_TOKEN, 'GET', path);
  if (res.status === 404 || res.status === 422) return null;
  if (!res.ok) throw new HttpError(502, `GitHub: ${res.status}`);
  return res.json();
}

const branchesOf = (env, owner, repo) => githubRead(env, `/repos/${owner}/${repo}/branches?per_page=100`).then((list) => list ?? []);

/** Mirrors what src/lib/scenarios/catalog.js listSources returns. */
async function loadSources(env) {
  const [owner, repo] = env.SCENARIOS_REPO.split('/');
  const [info, branches, forks] = await Promise.all([
    githubRead(env, `/repos/${owner}/${repo}`),
    branchesOf(env, owner, repo),
    githubRead(env, `/repos/${owner}/${repo}/forks?per_page=100`).catch(() => []),
  ]);
  if (!info) throw new HttpError(502, 'Scenarios repo not found');
  const sources = branches.map((b) => {
    const official = b.name === info.default_branch;
    return { label: official ? 'Official' : b.name, official, source: { owner, repo, ref: b.name }, sha: b.commit.sha };
  });
  const forkBranches = await Promise.all(
    (forks ?? []).map((fork) =>
      branchesOf(env, fork.owner.login, fork.name)
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

const getSources = (env) => remembered('sources', SOURCES_CACHE_MS, () => loadSources(env));

/**
 * Commit of `owner/repo@ref`, null when the repo / branch doesn't exist. Any repo may be asked for, so lookups
 * that reach GitHub are limited per IP: they spend the token's quota (the client then asks GitHub itself).
 */
async function getCommit(env, params, ip) {
  const owner = params.get('owner') ?? '';
  const repo = params.get('repo') ?? '';
  const ref = params.get('ref') ?? '';
  if (!REPO_PART_RE.test(owner) || !REPO_PART_RE.test(repo) || !REF_RE.test(ref)) throw new HttpError(400, 'Bad source');
  const key = `commit:${owner}/${repo}@${ref}`.toLowerCase();
  if (!isRemembered(key, COMMIT_CACHE_MS) && env.COMMIT_LIMIT && !(await env.COMMIT_LIMIT.limit({ key: ip })).success) {
    throw new HttpError(429, 'Too many lookups');
  }
  return remembered(key, COMMIT_CACHE_MS, async () => {
    const commit = await githubRead(env, `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`);
    return commit?.sha ?? null;
  });
}

/** After an editor save: the branch's new commit shows up straight away. */
function forgetScenarioCommits(env, branch) {
  memo.delete('sources');
  memo.delete(`commit:${env.SCENARIOS_REPO}@${branch}`.toLowerCase());
}

// ---------- HTTP ----------

function corsHeaders(env, request) {
  const origin = request.headers.get('Origin');
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  return origin && allowed.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' }
    : {};
}

const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/board') {
        return json({ board: await getBoard(env, url.searchParams.get('stage')) }, 200, cors);
      }
      if (request.method === 'POST' && url.pathname === '/results') {
        const sub = readSubmission(await request.json().catch(() => null));
        const ip = request.headers.get('CF-Connecting-IP') ?? '';
        if (env.SUBMIT_LIMIT && !(await env.SUBMIT_LIMIT.limit({ key: `${sub.playerId}|${ip}` })).success) {
          throw new HttpError(429, 'Too many submissions');
        }
        const { board, improved } = await submit(env, sub);
        const player = await playerHash(sub.playerId);
        const rank = board.entries.findIndex((e) => e.player === player && e.vehicle === sub.vehicle) + 1 || null;
        return json({ board, rank, improved }, 200, cors);
      }
      if (request.method === 'POST' && url.pathname === '/scenarios') {
        const save = readScenarioSave(await request.json().catch(() => null), env);
        const ip = request.headers.get('CF-Connecting-IP') ?? '';
        if (env.SAVE_LIMIT && !(await env.SAVE_LIMIT.limit({ key: ip })).success) throw new HttpError(429, 'Too many saves, wait a minute');
        const saved = await saveScenario(env, save);
        forgetScenarioCommits(env, save.branch);
        return json(saved, 200, cors);
      }
      if (request.method === 'GET' && url.pathname === '/scenarios/sources') {
        return json({ sources: await getSources(env) }, 200, cors);
      }
      if (request.method === 'GET' && url.pathname === '/scenarios/commit') {
        return json({ sha: await getCommit(env, url.searchParams, request.headers.get('CF-Connecting-IP') ?? '') }, 200, cors);
      }
      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return json({ error: status === 500 ? 'Server error' : err.message }, status, cors);
    }
  },
};
