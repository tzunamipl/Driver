import { PLAYERS_UPDATE_INTERVAL, PLAYERS_ACTIVE_THRESHOLD_MS } from '../config.js';

// Top-right "who's online" panel: everyone this browser has seen publish
// a pose in the shared room within the last 24h (see net.js's
// ROSTER_TTL_MS/localStorage persistence), including the local player,
// capped to the top 50 - sorted by activeness (most recently active
// first), then by score. Always visible (not gated by the M debug-visuals
// toggle), independent of the other HUD widgets.

const ROSTER_LIMIT = 50;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function statusLabel(idleMs) {
  if (idleMs < PLAYERS_ACTIVE_THRESHOLD_MS) return { text: 'Active', className: 'active' };
  const minutes = Math.max(1, Math.round(idleMs / 60_000));
  return { text: `Idle ${minutes}m`, className: 'idle' };
}

export function createPlayersPanel() {
  const listEl = document.getElementById('players-list');
  const countEl = document.getElementById('players-count');
  // Force an update on the very first call regardless of frame delta.
  let accum = PLAYERS_UPDATE_INTERVAL;

  function render(entries) {
    countEl.textContent = String(entries.length);
    listEl.innerHTML =
      entries
        .map((p) => {
          const status = statusLabel(p.idleMs);
          const name = escapeHtml(p.name) + (p.isLocal ? ' (you)' : '');
          return (
            `<div class="players-row${p.isLocal ? ' me' : ''}">` +
            `<span class="players-name">${name}</span>` +
            `<span class="players-score">${p.score}</span>` +
            `<span class="players-status ${status.className}">${status.text}</span>` +
            `</div>`
          );
        })
        .join('') || '<div class="players-empty">No one else around</div>';
  }

  function updatePlayersPanel(delta, { net, carManager, isJoined }) {
    accum += delta;
    if (accum < PLAYERS_UPDATE_INTERVAL) return;
    accum = 0;

    const entries = net.getRoster().map((p) => ({ ...p, isLocal: false }));
    if (isJoined()) {
      entries.push({
        id: net.clientId,
        name: carManager.getLocalName() || 'you',
        score: carManager.getScore(),
        idleMs: 0,
        isLocal: true,
      });
    }
    // Activeness first (least idle time wins), then score, so the panel
    // reads as "who's around right now, best players first" rather than a
    // pure leaderboard.
    entries.sort((a, b) => a.idleMs - b.idleMs || b.score - a.score || a.name.localeCompare(b.name));

    render(entries.slice(0, ROSTER_LIMIT));
  }

  return { updatePlayersPanel };
}
