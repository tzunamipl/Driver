// Instructions and the player list can be folded away. The Discord link
// sits outside the instructions body, so it stays visible either way.
// Narrow screens start folded so the panels don't cover the road.
//
// The help/instructions panel (#hud) additionally: starts open on load,
// then auto-collapses itself down to the small "Help" pill after
// AUTO_COLLAPSE_MS once the player has joined (name/color picked - see
// startAutoFold() below), if they haven't already toggled it manually.
//
// The players panel (#players-panel) has three stages, cycled by clicking
// its toggle: full list -> top 5 only ("medium") -> collapsed pill -> back
// to full. It also starts full and auto-folds itself down to the
// "medium" stage after PLAYERS_AUTO_FOLD_MS (same post-join timing as the
// help panel), unless the player has already interacted with it.
//
// Both auto-fold timers are deliberately *not* started until the caller
// (main.js, from the lobby's onJoined callback) calls startAutoFold() -
// starting them immediately on page load would let the 15s timer expire
// while the player is still filling in the name/color lobby form, folding
// the help text away before they ever got to read it.

const NARROW = '(max-width: 800px)';
const AUTO_COLLAPSE_MS = 15_000;
const PLAYERS_AUTO_FOLD_MS = 15_000;
const PLAYERS_STAGES = ['full', 'medium', 'collapsed'];

export function setupCollapsibleHud() {
  const startCollapsed = window.matchMedia(NARROW).matches;
  const hud = document.getElementById('hud');
  const hudToggle = document.getElementById('hud-toggle');
  const playersPanel = document.getElementById('players-panel');
  const playersToggle = document.getElementById('players-toggle');

  // Set once the player manually touches a toggle, so a later
  // startAutoFold() call never fights a choice they've already made -
  // mirrors the previous "cancel timer on first click" behavior, just
  // tracked as a flag since the timer itself is created later now.
  let hudInteracted = false;
  let playersInteracted = false;

  wire(hud, hudToggle, startCollapsed, () => {
    hudInteracted = true;
  });
  wirePlayersPanel(playersPanel, playersToggle, startCollapsed, () => {
    playersInteracted = true;
  });

  function startAutoFold() {
    if (hud && hudToggle && !startCollapsed && !hudInteracted) {
      setTimeout(() => {
        if (!hudInteracted && !hud.classList.contains('collapsed')) {
          hud.classList.add('collapsed');
          hudToggle.setAttribute('aria-expanded', 'false');
        }
      }, AUTO_COLLAPSE_MS);
    }
    if (playersPanel && playersToggle && !startCollapsed && !playersInteracted) {
      setTimeout(() => {
        if (!playersInteracted && playersStage(playersPanel) === 'full') setPlayersStage(playersPanel, playersToggle, 'medium');
      }, PLAYERS_AUTO_FOLD_MS);
    }
  }

  return { startAutoFold };
}

function wire(panel, button, startCollapsed, onInteract) {
  if (!panel || !button) return;
  if (startCollapsed) {
    panel.classList.add('collapsed');
    button.setAttribute('aria-expanded', 'false');
  }
  button.addEventListener('click', () => {
    onInteract();
    const collapsed = panel.classList.toggle('collapsed');
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
}

function playersStage(panel) {
  if (panel.classList.contains('collapsed')) return 'collapsed';
  if (panel.classList.contains('medium')) return 'medium';
  return 'full';
}

function setPlayersStage(panel, button, stage) {
  panel.classList.remove('medium', 'collapsed');
  if (stage !== 'full') panel.classList.add(stage);
  button.setAttribute('aria-expanded', stage === 'collapsed' ? 'false' : 'true');
}

function wirePlayersPanel(panel, button, startCollapsed, onInteract) {
  if (!panel || !button) return;

  if (startCollapsed) {
    setPlayersStage(panel, button, 'collapsed');
    return;
  }

  setPlayersStage(panel, button, 'full');
  button.addEventListener('click', () => {
    onInteract();
    const next = PLAYERS_STAGES[(PLAYERS_STAGES.indexOf(playersStage(panel)) + 1) % PLAYERS_STAGES.length];
    setPlayersStage(panel, button, next);
  });
}
