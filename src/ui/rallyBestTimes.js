// Best times beside the stage / rally picker's map: the online board of an official plan, one row
// per player and car at its best, each player's best first (a rally: one row per player, their best on each stage in any car
// summed, only over players that finished every stage), the player's own rows highlighted, and their local best below.

import { OFFICIAL_SCENARIO_SOURCE } from '../config.js';
import { leaderboardEnabled, fetchStageBoard, playerHash, rallyTotals } from '../lib/leaderboard.js';
import { readLocalBests, localBestKey } from '../lib/rally/localBest.js';
import { vehicleLabel } from '../lib/vehicles/index.js';
import { formatTime } from '../hud/rallyHud.js';

const TOP_N = 10;

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });

const stageIds = (plan) => plan.items.filter((item) => item.type === 'stage').map((item) => item.stage.id);

/** @param {{playerId: string}} opts */
export function createRallyBestTimes({ playerId }) {
  const root = el('div', 'rally-best');
  const box = el('div', 'rally-best-box');
  const list = el('div', 'rally-best-list');
  const local = el('div', 'rally-best-local');
  box.append(el('div', 'rally-best-title', 'Best times'), list);
  root.append(box, local);
  const me = playerHash(playerId);
  let showSeq = 0;

  const message = (text) => list.replaceChildren(el('div', 'rally-best-message', text));

  function row(entry, rank, mine) {
    const r = el('div', `rally-best-row${mine ? ' mine' : ''}`);
    r.append(
      el('span', 'rally-best-rank', `${rank}.`),
      el('span', 'rally-best-name', entry.name),
      el('span', 'rally-best-vehicle', vehicleLabel(entry.vehicle)),
      el('span', 'rally-best-time', formatTime(entry.totalMs))
    );
    return r;
  }

  function renderBoard(sorted, myHash) {
    if (!sorted.length) return message('No times yet');
    // Each player's best first, then their slower rows (other cars) below.
    const seen = new Set();
    const firsts = [], repeats = [];
    for (const r of sorted) {
      (seen.has(r.player) ? repeats : firsts).push(r);
      seen.add(r.player);
    }
    const rows = [...firsts, ...repeats];
    const mine = rows.findIndex((r) => r.player === myHash);
    const shown = rows.slice(0, TOP_N).map((r, i) => row(r, i + 1, r.player === myHash));
    if (mine >= TOP_N) shown.push(el('div', 'rally-best-gap', '…'), row(rows[mine], mine + 1, true));
    list.replaceChildren(...shown);
  }

  function renderLocal(plan) {
    const all = readLocalBests();
    const bests = stageIds(plan).map((id) => all[localBestKey(plan.source, id)]?.totalMs);
    const done = bests.filter((ms) => ms != null);
    if (plan.kind === 'stage') local.textContent = `Your best here: ${done.length ? formatTime(done[0]) : 'none yet'}`;
    else if (done.length === bests.length) local.textContent = `Your stage bests add up to ${formatTime(done.reduce((a, b) => a + b, 0))}`;
    else local.textContent = `Your bests: ${done.length} of ${bests.length} stages`;
  }

  /** @param {object | null} plan - from rallySession's buildPlan; null clears. */
  function show(plan) {
    const seq = ++showSeq;
    local.textContent = '';
    if (!plan) return list.replaceChildren();
    renderLocal(plan);
    if (!leaderboardEnabled()) return message('Online times are off');
    if (plan.source !== OFFICIAL_SCENARIO_SOURCE) return message('Online times are kept for official stages only');
    message('Loading…');
    Promise.all([Promise.all(stageIds(plan).map(fetchStageBoard)), me]).then(
      ([boards, myHash]) => {
        if (seq !== showSeq) return;
        const rows = plan.kind === 'stage' ? [...boards[0].entries] : rallyTotals(boards);
        renderBoard(rows.sort((a, b) => a.totalMs - b.totalMs), myHash);
      },
      (err) => {
        if (seq === showSeq) message(err.message);
      }
    );
  }

  return { el: root, show };
}
