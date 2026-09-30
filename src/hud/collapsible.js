// Instructions and the player list can be folded away. The Discord link
// sits outside the instructions body, so it stays visible either way.
// Narrow screens start folded so the panels don't cover the road.

const NARROW = '(max-width: 800px)';

export function setupCollapsibleHud() {
  const startCollapsed = window.matchMedia(NARROW).matches;
  wire(document.getElementById('hud'), document.getElementById('hud-toggle'), startCollapsed);
  wire(document.getElementById('players-panel'), document.getElementById('players-toggle'), startCollapsed);
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
