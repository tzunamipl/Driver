// Best times beside the stage / rally picker's map, in three tabs:
// Global best = the online board of an official plan, each player once at their best (a rally: their best on each stage
// in any car summed, only over players that finished every stage), the player's own row highlighted;
// Personal best = the player's own times, each car's best first, then more runs in the same cars (a stage: this device's
// runs + their online rows; a rally: finished rally totals on this device);
// Details = the file's meta (lib/scenarios/fileMeta.js): creator, last editor, dates, game version.

import { OFFICIAL_SCENARIO_SOURCE } from '../config.js';
import { leaderboardEnabled, fetchStageBoard, playerHash, rallyTotals, bestPerPlayer } from '../lib/leaderboard.js';
import { readLocalBests, readLocalRuns, localBestKey, localRallyKey } from '../lib/rally/localBest.js';
import { vehicleLabel } from '../lib/vehicles/index.js';
import { formatTime } from '../hud/rallyHud.js';

const TOP_N = 20;
const TABS = [
  { id: 'global', label: 'Global best' },
  { id: 'personal', label: 'Personal best' },
  { id: 'details', label: 'Details' },
];

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });

const stageIds = (plan) => plan.items.filter((item) => item.type === 'stage').map((item) => item.stage.id);

function formatDate(iso) {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–';
}

/** Each car's best first, then the other runs; fastest first within each. */
function carBestsFirst(runs) {
  const seen = new Set();
  const firsts = [], repeats = [];
  for (const run of [...runs].sort((a, b) => a.totalMs - b.totalMs)) {
    (seen.has(run.vehicle) ? repeats : firsts).push(run);
    seen.add(run.vehicle);
  }
  return [...firsts, ...repeats];
}

/** @param {{playerId: string}} opts */
export function createRallyBestTimes({ playerId }) {
  const root = el('div', 'rally-best');
  const tabsEl = el('div', 'rally-vehicle-tabs rally-best-tabs');
  const box = el('div', 'rally-best-box');
  const list = el('div', 'rally-best-list');
  box.append(list);
  root.append(tabsEl, box);
  const me = playerHash(playerId);
  let tab = TABS[0].id;
  let shown = null; // { plan, online: null | { rows, myHash } | { error } | { loading: true } | { off: text } }
  let showSeq = 0;

  const message = (text) => list.replaceChildren(el('div', 'rally-best-message', text));

  function renderTabs() {
    tabsEl.replaceChildren(
      ...TABS.map(({ id, label }) => {
        const button = el('button', `vehicle-tab${id === tab ? ' active' : ''}`, label);
        button.type = 'button';
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(id === tab));
        button.addEventListener('click', () => {
          if (tab === id) return;
          tab = id;
          renderTabs();
          render();
        });
        return button;
      })
    );
  }

  function row(rank, name, vehicle, ms, mine) {
    const r = el('div', `rally-best-row${mine ? ' mine' : ''}`);
    r.append(
      el('span', 'rally-best-rank', `${rank}.`),
      el('span', 'rally-best-name', name),
      el('span', 'rally-best-vehicle', vehicle),
      el('span', 'rally-best-time', formatTime(ms))
    );
    return r;
  }

  function renderGlobal({ online }) {
    if (online.off) return message(online.off);
    if (online.loading) return message('Loading…');
    if (online.error) return message(online.error);
    const { myHash } = online;
    const rows = bestPerPlayer(online.rows);
    if (!rows.length) return message('No times yet');
    const mine = rows.findIndex((r) => r.player === myHash);
    const entry = (r, i) => row(i + 1, r.name, vehicleLabel(r.vehicle), r.totalMs, r.player === myHash);
    const out = rows.slice(0, TOP_N).map(entry);
    if (mine >= TOP_N) out.push(el('div', 'rally-best-gap', '…'), entry(rows[mine], mine));
    list.replaceChildren(...out);
  }

  /** The player's runs: this device's, the old single local best, their online rows; one copy of each. */
  function personalRuns({ plan, online }) {
    if (plan.kind === 'rally') return readLocalRuns(localRallyKey(plan.source, plan.id));
    const key = localBestKey(plan.source, stageIds(plan)[0]);
    const runs = [...readLocalRuns(key)];
    const best = readLocalBests()[key];
    // Kept from before runs remembered their car.
    if (best && !runs.some((r) => r.totalMs === best.totalMs)) runs.push({ totalMs: best.totalMs, vehicle: undefined });
    for (const e of online.rows ?? []) {
      if (e.player === online.myHash && !runs.some((r) => r.totalMs === e.totalMs && r.vehicle === e.vehicle)) runs.push({ totalMs: e.totalMs, vehicle: e.vehicle, at: e.at });
    }
    return runs;
  }

  function renderPersonal(view) {
    const runs = carBestsFirst(personalRuns(view)).slice(0, TOP_N);
    if (!runs.length) return message(view.plan.kind === 'rally' ? 'No finished rallies yet' : 'No times yet');
    const out = runs.map((r, i) => row(i + 1, r.at ? formatDate(r.at) : '–', r.vehicle === undefined ? 'Unknown car' : vehicleLabel(r.vehicle), r.totalMs, false));
    if (view.online.loading && view.plan.kind === 'stage') out.push(el('div', 'rally-best-message', 'Loading online times…'));
    list.replaceChildren(...out);
  }

  function renderDetails({ plan }) {
    const meta = plan.meta ?? {};
    const build = meta.version ? `v${meta.version}${meta.build ? `_${meta.build}` : ''}` : '–';
    const table = el('table', 'rally-best-details');
    for (const [label, value] of [
      ['Created by', meta.createdBy ?? '–'],
      ['Created', formatDate(meta.createdAt)],
      ['Last edited by', meta.editedBy ?? '–'],
      ['Last edited', formatDate(meta.editedAt)],
      ['Game version', build],
      ['Source', plan.source],
    ]) {
      const tr = el('tr');
      tr.append(el('th', '', label), el('td', '', value));
      table.append(tr);
    }
    list.replaceChildren(table);
  }

  function render() {
    if (!shown) return list.replaceChildren();
    if (tab === 'global') renderGlobal(shown);
    else if (tab === 'personal') renderPersonal(shown);
    else renderDetails(shown);
  }

  /** @param {object | null} plan - from rallySession's buildPlan; null clears. */
  function show(plan) {
    const seq = ++showSeq;
    shown = plan && { plan, online: { loading: true } };
    renderTabs();
    if (!plan) return render();
    if (!leaderboardEnabled()) shown.online = { off: 'Online times are off' };
    else if (plan.source !== OFFICIAL_SCENARIO_SOURCE) shown.online = { off: 'Online times are kept for official stages only' };
    render();
    if (!shown.online.loading) return;
    Promise.all([Promise.all(stageIds(plan).map(fetchStageBoard)), me]).then(
      ([boards, myHash]) => {
        if (seq !== showSeq) return;
        const rows = plan.kind === 'stage' ? [...boards[0].entries] : rallyTotals(boards);
        shown.online = { rows: rows.sort((a, b) => a.totalMs - b.totalMs), myHash };
        render();
      },
      (err) => {
        if (seq !== showSeq) return;
        shown.online = { error: err.message };
        render();
      }
    );
  }

  return { el: root, show };
}
