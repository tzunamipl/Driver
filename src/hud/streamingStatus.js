// Small bottom-of-screen pill with two progress bars for the current burst:
// downloads (fetch + decode) and, below, rendering left (mesh builds, object placement).

const UPDATE_INTERVAL = 0.25; // s
// Show only after a short busy spell and linger a bit, so quick loads don't flicker.
const SHOW_AFTER = 0.4; // s
const HIDE_AFTER = 1.0; // s

/** One labelled bar; `update` takes [[name, count], ...] and returns whether it's shown. */
function createSection(root, title) {
  const label = root.querySelector('.streaming-status-text');
  const percent = root.querySelector('.streaming-status-percent');
  const fill = root.querySelector('.streaming-status-fill');
  let busyFor = 0;
  let idleFor = 0;
  // Largest pending total seen this burst: the bar's denominator, since new work keeps arriving.
  let peak = 0;

  return function update(step, layers) {
    const total = layers.reduce((sum, [, n]) => sum + n, 0);
    if (total > 0) {
      busyFor += step;
      idleFor = 0;
      peak = Math.max(peak, total);
      const fraction = (peak - total) / peak;
      label.textContent = [
        title,
        ...layers.filter(([, n]) => n > 0).map(([name, n]) => `${name} ${n}`),
      ].join(' · ');
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
    return !root.hidden;
  };
}

export function createStreamingStatus() {
  const root = document.getElementById('streaming-status');
  const downloads = createSection(root.querySelector('[data-kind="download"]'), 'Downloading');
  const renders = createSection(root.querySelector('[data-kind="render"]'), 'Rendering');
  let accum = 0;

  /** Every streamer has pendingWork() -> { downloads, builds }. */
  function update(delta, { terrain, buildings, streets, rivers, waterAreas, builtUpAreas, landcoverAreas, roadside, trees, bushes, rocks }) {
    accum += delta;
    if (accum < UPDATE_INTERVAL) return;
    const step = accum;
    accum = 0;

    const groups = [
      ['terrain', [terrain]],
      ['buildings', [buildings]],
      ['roads', [streets]],
      ['water', [rivers, waterAreas]],
      ['landuse', [builtUpAreas, landcoverAreas]],
      ['roadside', [roadside]],
      ['trees', [trees, bushes]],
      ['rocks', [rocks]],
    ].map(([name, parts]) => [name, parts.map((part) => part.pendingWork())]);
    const sum = (works, key) => works.reduce((total, work) => total + work[key], 0);

    const renderName = (name) => (name === 'roads' && streets.surfaceShown ? 'road surface' : name);
    const downloadShown = downloads(step, groups.map(([name, works]) => [name, sum(works, 'downloads')]));
    const renderShown = renders(step, groups.map(([name, works]) => [renderName(name), sum(works, 'builds')]));
    root.hidden = !downloadShown && !renderShown;
  }

  return { update };
}
