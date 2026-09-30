// Instructions and the player list can be folded away. The Discord link
// sits outside the instructions body, so it stays visible either way.
// Narrow screens start folded so the panels don't cover the road.
//
// The help/instructions panel (#hud) additionally: starts open on load,
// then auto-collapses itself down to the small "Help" pill after
// AUTO_COLLAPSE_MS if the player hasn't already toggled it manually, and
// has its own "x" button (#hud-hide) to dismiss it entirely (beyond just
// collapsing) for players who don't want it back at all this session.

const NARROW = '(max-width: 800px)';
const AUTO_COLLAPSE_MS = 10_000;

export function setupCollapsibleHud() {
  const startCollapsed = window.matchMedia(NARROW).matches;
  const hud = document.getElementById('hud');
  const hudToggle = document.getElementById('hud-toggle');
  wire(hud, hudToggle, startCollapsed);
  wire(document.getElementById('players-panel'), document.getElementById('players-toggle'), startCollapsed);

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

  document.getElementById('hud-hide')?.addEventListener('click', () => {
    if (!hud) return;
    // Play the fade/slide-out transition (see #hud.hiding in index.html)
    // before actually removing the panel from layout, rather than
    // snapping straight to display: none.
    hud.classList.add('hiding');
    hud.addEventListener(
      'transitionend',
      () => {
        hud.classList.add('hidden');
      },
      { once: true }
    );
  });
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
