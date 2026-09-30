// On-screen hold buttons for a phone. They share the keyboard set, so gas
// is W, steer is A/D, and shoot is F (including the shot cooldown).

export function setupTouchControls(keys) {
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
  }
}
