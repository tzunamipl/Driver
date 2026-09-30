// Instructions and the player list can be folded away. The Discord link
// sits outside the instructions body, so it stays visible either way.
// Narrow screens start folded so the panels don't cover the road.
//
// The help/instructions panel (#hud) additionally: starts open on load,
// then auto-collapses itself down to the small "Help" pill after
// AUTO_COLLAPSE_MS if the player hasn't already toggled it manually.
//
// The players panel (#players-panel) has three stages, cycled by clicking
// its toggle: full list -> top 5 only ("medium") -> collapsed pill -> back
// to full. It also starts full and auto-folds itself down to the
// "medium" stage after PLAYERS_AUTO_FOLD_MS, mirroring the help panel's
// auto-collapse, unless the player has already interacted with it.

const NARROW = '(max-width: 800px)';
const AUTO_COLLAPSE_MS = 15_000;
const PLAYERS_AUTO_FOLD_MS = 15_000;
const PLAYERS_STAGES = ['full', 'medium', 'collapsed'];

export function setupCollapsibleHud() {
  const startCollapsed = window.matchMedia(NARROW).matches;
  const hud = document.getElementById('hud');
  const hudToggle = document.getElementById('hud-toggle');
  wire(hud, hudToggle, startCollapsed);
  wirePlayersPanel(document.getElementById('players-panel'), document.getElementById('players-toggle'), startCollapsed);

  if (hud && hudToggle && !startCollapsed) {
    // Cancelled the moment the player interacts with the toggle themselves
    // (expanding/re-collapsing manually shouldn't be fought by a stale
    // timer a few seconds later).
    const timer = setTimeout(() => {
      if (!hud.classList.contains('collapsed')) {
        hud.classList.add('collapsed');
        hudToggle.setAttribute('aria-expanded', 'false');
      }
    }, AUTO_COLLAPSE_MS);
    hudToggle.addEventListener('click', () => clearTimeout(timer), { once: true });
  }
}

function wire(panel, button, startCollapsed) {
  if (!panel || !button) return;
  if (startCollapsed) {
    panel.classList.add('collapsed');
    button.setAttribute('aria-expanded', 'false');
  }
  button.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
}

function playersStage(panel) {
  if (panel.classList.contains('collapsed')) return 'collapsed';
  if (panel.classList.contains('medium')) return 'medium';
  return 'full';
}

function wirePlayersPanel(panel, button, startCollapsed) {
  if (!panel || !button) return;

  const setStage = (stage) => {
    panel.classList.remove('medium', 'collapsed');
    if (stage !== 'full') panel.classList.add(stage);
    button.setAttribute('aria-expanded', stage === 'collapsed' ? 'false' : 'true');
  };

  if (startCollapsed) {
    setStage('collapsed');
    return;
  }

  setStage('full');
  button.addEventListener('click', () => {
    const next = PLAYERS_STAGES[(PLAYERS_STAGES.indexOf(playersStage(panel)) + 1) % PLAYERS_STAGES.length];
    setStage(next);
  });

  // Same cancel-on-manual-interaction pattern as the help panel's
  // auto-collapse: only auto-fold if the player hasn't already touched
  // the toggle themselves.
  const timer = setTimeout(() => {
    if (playersStage(panel) === 'full') setStage('medium');
  }, PLAYERS_AUTO_FOLD_MS);
  button.addEventListener('click', () => clearTimeout(timer), { once: true });
}
