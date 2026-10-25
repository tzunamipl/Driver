// The player list can be folded away. Narrow screens start folded so it doesn't cover the road.
//
// It has three stages, cycled by clicking its toggle: full list -> top 5 only ("medium") ->
// collapsed pill -> back to full. It starts full and auto-folds down to "medium" after
// PLAYERS_AUTO_FOLD_MS, unless the player has already interacted with it.
//
// The auto-fold timer is deliberately *not* started until the caller (main.js, from the
// lobby's onJoined callback) calls startAutoFold(), so it can't run out while the player is
// still filling in the lobby form.

const NARROW = '(max-width: 800px)';
const PLAYERS_AUTO_FOLD_MS = 15_000;
const PLAYERS_STAGES = ['full', 'medium', 'collapsed'];

export function setupCollapsibleHud() {
  const startCollapsed = window.matchMedia(NARROW).matches;
  const playersPanel = document.getElementById('players-panel');
  const playersToggle = document.getElementById('players-toggle');

  // Set once the player touches the toggle, so a later startAutoFold() never fights their choice.
  let playersInteracted = false;
  wirePlayersPanel(playersPanel, playersToggle, startCollapsed, () => {
    playersInteracted = true;
  });

  function startAutoFold() {
    if (playersPanel && playersToggle && !startCollapsed && !playersInteracted) {
      setTimeout(() => {
        if (!playersInteracted && playersStage(playersPanel) === 'full') setPlayersStage(playersPanel, playersToggle, 'medium');
      }, PLAYERS_AUTO_FOLD_MS);
    }
  }

  return { startAutoFold };
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
