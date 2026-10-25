// Debug-view panels stack in a column; a panel that would run behind the minimap (or past
// the bottom of the window) moves to a new column beside it.

const BOTTOM_MARGIN_PX = 10;

/** Minimap top (incl. its info box above the dial) and right edge, or null when hidden. */
function minimapRect(minimap) {
  const r = minimap?.getBoundingClientRect();
  if (!r || r.width === 0) return null;
  let top = r.top;
  const info = minimap.querySelector('#minimap-info')?.getBoundingClientRect();
  if (info && info.width > 0) top = Math.min(top, info.top);
  return { top, right: r.right };
}

export function setupDebugHudWrap(row, panels, minimap) {
  let layoutKey = '';
  let pending = false;

  function layout() {
    pending = false;
    const style = getComputedStyle(row);
    const rowGap = parseFloat(style.rowGap) || 0;
    const colGap = parseFloat(style.columnGap) || 0;
    const rowRect = row.getBoundingClientRect();
    const map = minimapRect(minimap);
    const windowLimit = window.innerHeight - BOTTOM_MARGIN_PX;
    const limitAt = (left) => (map && left < map.right ? Math.min(windowLimit, map.top - BOTTOM_MARGIN_PX) : windowLimit);

    const lanes = [];
    let lane = null;
    let laneH = 0;
    let laneW = 0;
    let laneLeft = rowRect.left;
    for (const panel of panels) {
      const h = panel.offsetHeight;
      if (!lane || (h > 0 && laneH > 0 && rowRect.top + laneH + rowGap + h > limitAt(laneLeft))) {
        if (lane) laneLeft += laneW + colGap;
        lane = [];
        lanes.push(lane);
        laneH = 0;
        laneW = 0;
      }
      lane.push(panel);
      if (h > 0) {
        laneH += (laneH > 0 ? rowGap : 0) + h;
        laneW = Math.max(laneW, panel.offsetWidth);
      }
    }

    const key = lanes.map((l) => l.map((p) => p.id).join(',')).join('|');
    if (key === layoutKey) return;
    layoutKey = key;
    const cols = [...row.querySelectorAll(':scope > .debug-hud-col')];
    lanes.forEach((l, i) => {
      let col = cols[i];
      if (!col) {
        col = document.createElement('div');
        col.className = 'debug-hud-col';
        row.appendChild(col);
        cols.push(col);
      }
      for (const panel of l) col.appendChild(panel);
    });
    for (const col of cols.slice(lanes.length)) col.remove();
  }

  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(layout);
  };
  const observer = new ResizeObserver(schedule);
  for (const panel of panels) observer.observe(panel);
  // The row moves down when the panels above it (settings, pacenotes) grow.
  if (row.parentElement) observer.observe(row.parentElement);
  if (minimap) observer.observe(minimap);
  window.addEventListener('resize', schedule);
  schedule();
}
