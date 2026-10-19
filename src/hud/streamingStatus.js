// Small bottom-of-screen pill with per-layer pending counts and a progress bar
// for the current loading burst.

const UPDATE_INTERVAL = 0.25; // s
// Show only after a short busy spell and linger a bit, so quick loads don't flicker.
const SHOW_AFTER = 0.4; // s
const HIDE_AFTER = 1.0; // s

export function createStreamingStatus() {
  const root = document.getElementById('streaming-status');
  const label = root.querySelector('.streaming-status-text');
  const percent = root.querySelector('.streaming-status-percent');
  const fill = root.querySelector('.streaming-status-fill');
  let accum = 0;
  let busyFor = 0;
  let idleFor = 0;
  // Largest pending total seen this burst: the bar's denominator, since new work keeps arriving.
  let peak = 0;

  function update(delta, { terrain, buildings, streets, rivers, waterAreas, builtUpAreas }) {
    accum += delta;
    if (accum < UPDATE_INTERVAL) return;
    const step = accum;
    accum = 0;

    const layers = [
      ['terrain', terrain.pendingCount()],
      ['buildings', buildings.pendingCount()],
      ['roads', streets.pendingCount()],
      ['water', rivers.pendingCount() + waterAreas.pendingCount()],
      ['landuse', builtUpAreas.pendingCount()],
    ];
    const total = layers.reduce((sum, [, n]) => sum + n, 0);

    if (total > 0) {
      busyFor += step;
      idleFor = 0;
      peak = Math.max(peak, total);
      const fraction = (peak - total) / peak;
      label.textContent = layers
        .filter(([, n]) => n > 0)
        .map(([name, n]) => `${name} ${n}`)
        .join(' · ');
      percent.textContent = `${Math.round(fraction * 100)}%`;
      fill.style.width = `${fraction * 100}%`;
      if (busyFor >= SHOW_AFTER) root.hidden = false;
    } else {
      idleFor += step;
      busyFor = 0;
      peak = 0;
      percent.textContent = '100%';
      fill.style.width = '100%';
      if (idleFor >= HIDE_AFTER) root.hidden = true;
    }
  }

  return { update };
}
