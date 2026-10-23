// Driver API: checks stage times against the official stage files and keeps each player's best
// per vehicle in a GitHub data repo, one JSON file per stage; commits editor saves to a player's
// branch of the scenarios repo, with a PR into the official branch. The tokens stay here.
//   GET  /board?stage=<country/region/id>  -> { board }
//   POST /results { stage, sha, playerId, name, vehicle, totalMs, splits, penaltyMs, version }
//        -> { board, rank, improved }
//   POST /scenarios { branch, folder, kindFolder, key, content } -> { owner, repo, branch, sha, unchanged, pr }
//   POST /player/load { playerId } -> { save: { updatedAt, data } | null }
//   POST /player/save { playerId, updatedAt, data } -> { stored }  (also sent as a text/plain beacon)

const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
const STAGE_KEY_RE = new RegExp(`^(?:${SLUG}/${SLUG}/)?${SLUG}$`); // bare `id` = flat layout from before countries
const PLAYER_ID_RE = /^[0-9a-f-]{8,64}$/i;
const VEHICLE_RE = /^[\w-]{1,40}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^[\w.-]{1,20}$/;
const MAX_AVG_SPEED_MPS = 90; // straight-line average between gates; quicker is not a real run
const MAX_TIME_MS = 6 * 3600_000;
const PENALTIES_MS = [0, 10_000];
const NAME_MAX = 24;
const MAX_ENTRIES = 1000;
const PUT_RETRIES = 3;
const STAGE_CACHE_S = 300;
const BRANCH_RE = new RegExp(`^${SLUG}$`);
const BRANCH_MAX = 40;
const SCENARIO_MAX_BYTES = 256 * 1024;
const PLAYER_SAVE_MAX_BYTES = 128 * 1024;
// localStorage keys a player backup may hold (src/lib/cloudSave.js).
const PLAYER_SAVE_KEYS = new Set(['driver.saves.v1', 'driver.lobby.v1', 'driver.vehicleOdometers.v1']);
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
const boardPath = (key) => `rally/${key}.json`;

async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Public id on the board: the raw player id is also the MQTT identity. */
const playerHash = async (playerId) => (await sha256Hex(playerId)).slice(0, 16);

async function fetchStage(env, key, ref) {
  const res = await fetch(`https://raw.githubusercontent.com/${env.SCENARIOS_REPO}/${ref}/${stageFilePath(key)}`, {
    cf: { cacheTtl: STAGE_CACHE_S, cacheEverything: true },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(502, `Scenarios repo: ${res.status}`);
  return res.json();
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
  if (!STAGE_KEY_RE.test(stage ?? '')) throw new HttpError(400, 'Bad stage');
  if (!SHA_RE.test(sha ?? '')) throw new HttpError(400, 'Bad sha');
  if (!PLAYER_ID_RE.test(playerId ?? '')) throw new HttpError(400, 'Bad playerId');
  if (!VEHICLE_RE.test(vehicle ?? '')) throw new HttpError(400, 'Bad vehicle');
  if (!VERSION_RE.test(version || '0')) throw new HttpError(400, 'Bad version');
  if (!Number.isInteger(totalMs) || totalMs <= 0 || totalMs > MAX_TIME_MS) throw new HttpError(400, 'Bad totalMs');
  if (!PENALTIES_MS.includes(penaltyMs)) throw new HttpError(400, 'Bad penaltyMs');
  if (!Array.isArray(splits) || splits.length > 100) throw new HttpError(400, 'Bad splits');
  const cleanName = String(name ?? '').replace(/[\p{C}]/gu, '').trim().slice(0, NAME_MAX) || 'Player';
  return { stage, sha, playerId, name: cleanName, vehicle, totalMs, splits, penaltyMs, version };
}

// ---------- GitHub data repo ----------

const toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
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

const gh = (env, method, path, body) => github(env.DATA_TOKEN, method, `/repos/${env.DATA_REPO}${path}`, body);

/** Board file + its blob sha (null when the file doesn't exist yet). */
async function readBoard(env, key) {
  const res = await gh(env, 'GET', `/contents/${boardPath(key)}?ref=${encodeURIComponent(env.DATA_BRANCH)}`);
  if (res.status === 404) return { board: null, sha: null };
  if (!res.ok) throw new HttpError(502, `Data repo: ${res.status}`);
  const file = await res.json();
  return { board: JSON.parse(fromBase64(file.content)), sha: file.sha };
}

/** Board as it stands for this stage version: one stale from an older version reads empty. */
const currentBoard = (board, key, print) =>
  board?.fingerprint === print ? board : { stage: key, fingerprint: print, entries: [] };

async function submit(env, sub) {
  const [atRun, atHead] = await Promise.all([fetchStage(env, sub.stage, sub.sha), fetchStage(env, sub.stage, env.SCENARIOS_BRANCH)]);
  if (!atRun || !atHead) throw new HttpError(404, 'Not an official stage');
  const print = await fingerprint(atHead);
  if ((await fingerprint(atRun)) !== print) throw new HttpError(409, 'Stage has changed since this run');
  checkTimes(atHead, sub);

  const player = await playerHash(sub.playerId);
  const entry = {
    player,
    name: sub.name,
    vehicle: sub.vehicle,
    totalMs: sub.totalMs,
    splits: sub.splits,
    penaltyMs: sub.penaltyMs,
    at: new Date().toISOString(),
    version: sub.version,
  };
  for (let attempt = 0; ; attempt++) {
    const { board: stored, sha } = await readBoard(env, sub.stage);
    const board = currentBoard(stored, sub.stage, print);
    const mine = (e) => e.player === player && e.vehicle === sub.vehicle;
    const own = board.entries.find(mine);
    if (own && own.totalMs <= entry.totalMs) return { board, improved: false };
    const entries = [...board.entries.filter((e) => !mine(e)), entry]
      .sort((a, b) => a.totalMs - b.totalMs || a.at.localeCompare(b.at))
      .slice(0, MAX_ENTRIES);
    const next = { stage: sub.stage, fingerprint: print, entries };
    const res = await gh(env, 'PUT', `/contents/${boardPath(sub.stage)}`, {
      message: `${sub.stage}: ${sub.name} ${(sub.totalMs / 1000).toFixed(1)} s`,
      content: toBase64(`${JSON.stringify(next, null, 1)}\n`),
      branch: env.DATA_BRANCH,
      ...(sha ? { sha } : {}),
    });
    if (res.ok) return { board: next, improved: true };
    // Someone else wrote the file in between: read it again.
    if ((res.status === 409 || res.status === 422) && attempt < PUT_RETRIES) continue;
    throw new HttpError(502, `Data repo: ${res.status}`);
  }
}

async function getBoard(env, key) {
  if (!STAGE_KEY_RE.test(key ?? '')) throw new HttpError(400, 'Bad stage');
  const head = await fetchStage(env, key, env.SCENARIOS_BRANCH);
  if (!head) throw new HttpError(404, 'Not an official stage');
  const { board } = await readBoard(env, key);
  return currentBoard(board, key, await fingerprint(head));
}

// ---------- Player backups ----------

const playerSavePath = (player) => `players/${player}.json`;

function readPlayerSave(body) {
  const { playerId, updatedAt, data } = body ?? {};
  if (!PLAYER_ID_RE.test(playerId ?? '')) throw new HttpError(400, 'Bad playerId');
  if (!Number.isInteger(updatedAt) || updatedAt <= 0) throw new HttpError(400, 'Bad updatedAt');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Bad data');
  for (const [key, value] of Object.entries(data)) {
    if (!PLAYER_SAVE_KEYS.has(key) || (value !== null && typeof value !== 'string')) throw new HttpError(400, 'Bad data');
  }
  if (JSON.stringify(data).length > PLAYER_SAVE_MAX_BYTES) throw new HttpError(413, 'Save too large');
  return { playerId, updatedAt, data };
}

/** Backup file + its blob sha (null when the player has none). */
async function readPlayerFile(env, player) {
  const res = await gh(env, 'GET', `/contents/${playerSavePath(player)}?ref=${encodeURIComponent(env.DATA_BRANCH)}`);
  if (res.status === 404) return { save: null, sha: null };
  if (!res.ok) throw new HttpError(502, `Data repo: ${res.status}`);
  const file = await res.json();
  return { save: JSON.parse(fromBase64(file.content)), sha: file.sha };
}

async function loadPlayer(env, body) {
  if (!PLAYER_ID_RE.test(body?.playerId ?? '')) throw new HttpError(400, 'Bad playerId');
  const { save } = await readPlayerFile(env, await playerHash(body.playerId));
  return { save: save && { updatedAt: save.updatedAt, data: save.data } };
}

/** Keeps the newer copy: one older than the stored backup (another tab, a late beacon) is dropped. */
async function savePlayer(env, sub) {
  const player = await playerHash(sub.playerId);
  for (let attempt = 0; ; attempt++) {
    const { save, sha } = await readPlayerFile(env, player);
    if (save && save.updatedAt >= sub.updatedAt) return { stored: false };
    const res = await gh(env, 'PUT', `/contents/${playerSavePath(player)}`, {
      message: `player ${player}`,
      content: toBase64(`${JSON.stringify({ updatedAt: sub.updatedAt, data: sub.data })}\n`),
      branch: env.DATA_BRANCH,
      ...(sha ? { sha } : {}),
    });
    if (res.ok) return { stored: true };
    if ((res.status === 409 || res.status === 422) && attempt < PUT_RETRIES) continue;
    throw new HttpError(502, `Data repo: ${res.status}`);
  }
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
        return json(await saveScenario(env, save), 200, cors);
      }
      if (request.method === 'POST' && url.pathname === '/player/load') {
        return json(await loadPlayer(env, await request.json().catch(() => null)), 200, cors);
      }
      if (request.method === 'POST' && url.pathname === '/player/save') {
        // Read as text: beacons come as text/plain.
        const sub = readPlayerSave(await request.text().then(JSON.parse).catch(() => null));
        const ip = request.headers.get('CF-Connecting-IP') ?? '';
        if (env.PLAYER_LIMIT && !(await env.PLAYER_LIMIT.limit({ key: `${sub.playerId}|${ip}` })).success) {
          throw new HttpError(429, 'Too many saves');
        }
        return json(await savePlayer(env, sub), 200, cors);
      }
      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      return json({ error: status === 500 ? 'Server error' : err.message }, status, cors);
    }
  },
};
