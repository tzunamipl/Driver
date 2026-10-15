// Always-on FPS readout beside the version badge; its own rAF so it needs no main-loop wiring.
const UPDATE_INTERVAL_MS = 500;

export function createFpsCounter() {
  const el = document.getElementById('fps-counter');
  if (!el) return;
  let frames = 0;
  let since = performance.now();
  function tick(now) {
    frames++;
    if (now - since >= UPDATE_INTERVAL_MS) {
      el.textContent = `${Math.round((frames * 1000) / (now - since))} fps`;
      frames = 0;
      since = now;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
