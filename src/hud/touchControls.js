// On-screen hold buttons for a phone. They share the keyboard set, so gas
// is W, steer is A/D, and shoot is F (including the shot cooldown).

export function setupTouchControls(keys) {
  // A finger on "Gas" or "Shoot" would otherwise select that label and
  // the selection handles steal the rest of the touch. Typing fields stay
  // selectable.
  document.addEventListener('selectstart', (event) => {
    const el = event.target;
    if (el instanceof Element && el.closest('input, textarea')) return;
    event.preventDefault();
  });

  const root = document.getElementById('touch-controls');
  if (!root) return;
  for (const button of root.querySelectorAll('button[data-code]')) {
    const code = button.dataset.code;
    const press = (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      keys.add(code);
    };
    const release = () => keys.delete(code);
    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('contextmenu', (event) => event.preventDefault());
  }
}
