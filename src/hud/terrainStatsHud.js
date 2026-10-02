import { DIRECTIONS, STATS_UPDATE_INTERVAL } from '../config.js';
import { computeHeadingDeg, headingDirection } from '../lib/heading.js';

// Terrain/buildings streaming stats HUD (memory usage + tile streaming
// map). Debug-only overlay; disabled outright when debug visuals are off
// so its (relatively expensive) DOM rebuild never runs during normal play.

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function createTerrainStatsHud() {
  const terrainStatsEl = document.getElementById('terrain-stats');
  let statsAccum = 0;
  let fps = 0;
  let fpsAccum = 0;
  let fpsFrames = 0;

  function updateTerrainStats(delta, { terrain, buildings, chassisMesh, debugVisualsEnabled, pedestrians }) {
    if (!debugVisualsEnabled || !chassisMesh) return;

    fpsAccum += delta;
    fpsFrames += 1;
    if (fpsAccum >= 0.5) {
      fps = fpsFrames / fpsAccum;
      fpsAccum = 0;
      fpsFrames = 0;
    }

    statsAccum += delta;
    if (statsAccum < STATS_UPDATE_INTERVAL) return;
    statsAccum = 0;

    const headingDeg = computeHeadingDeg(chassisMesh);
    const dir = headingDirection(headingDeg, DIRECTIONS);

    const s = terrain.getStats();
    const aheadTx = s.center.tx + dir.dx;
    const aheadTy = s.center.ty + dir.dy;

    const b = buildings.getStats();
    const pedCount = pedestrians?.getCount ? pedestrians.getCount() : null;
    const textLines = [
      'TERRAIN',
      `fps: ${fps.toFixed(0)}`,
      `detail: ${s.loaded} loaded  ${s.pending} loading  ${s.pendingRemoval} removing`,
      `far:    ${s.far.loaded} loaded  ${s.far.pending} loading  ${s.far.pendingRemoval} removing`,
      `created: ${s.created}/${s.far.created}  removed: ${s.removed}/${s.far.removed}`,
      `~memory: ${formatBytes(s.memoryBytes + s.far.memoryBytes)}`,
      `ahead: ${aheadTx},${aheadTy}`,
      `buildings: ${b.buildings} in ${b.loaded} tiles${b.regionLoading ? ' (region loading\u2026)' : ''}  ~${formatBytes(b.memoryBytes)}`,
    ];
    if (s.stray) textLines.push(`stray tiles (off-grid): ${s.stray}`);
    if (pedCount != null) textLines.push(`ludziki: ${pedCount}`);
    if (b.usingCachedData) {
      textLines.push(`buildings: offline \u2013 showing cached data from local storage`);
    } else if (b.regionFailed) {
      textLines.push(`buildings: tile service unreachable (network blocked?), retrying\u2026`);
      if (b.lastError) textLines.push(`  ${b.lastError.slice(0, 60)}`);
    }

    const cols = s.grid[0].length;
    terrainStatsEl.innerHTML =
      `<div class="ts-text">${textLines.join('\n')}</div>` +
      `<div class="ts-compass-wrap">` +
      `<span class="ts-dir n">N</span><span class="ts-dir s">S</span>` +
      `<span class="ts-dir w">W</span><span class="ts-dir e">E</span>` +
      `<div class="ts-grid" style="grid-template-columns: repeat(${cols}, 14px)">` +
      s.grid
        .map((row, ry) =>
          row
            .map((state, rx) => {
              const isPlayer = state === 'player';
              const cellState = isPlayer ? 'loaded' : state;
              const isAhead = ry - s.gridCenter.row === dir.dy && rx - s.gridCenter.col === dir.dx;
              const classes = ['ts-cell', cellState];
              if (isPlayer) classes.push('player');
              if (isAhead) classes.push('ahead');
              const glyph = isPlayer ? dir.arrow : '';
              return `<span class="${classes.join(' ')}">${glyph}</span>`;
            })
            .join('')
        )
        .join('') +
      `</div></div>` +
      `<div class="ts-legend">` +
      `<span><span class="swatch" style="background:rgba(76,175,80,0.7)"></span>loaded</span>` +
      `<span><span class="swatch" style="background:rgba(255,193,7,0.7)"></span>planned</span>` +
      `<span><span class="swatch" style="background:rgba(244,67,54,0.55)"></span>removing</span>` +
      `<span><span class="swatch" style="background:rgba(255,255,255,0.1)"></span>empty</span>` +
      `<span>${dir.arrow} you / ahead highlighted</span>` +
      `</div>`;
  }

  return { updateTerrainStats, el: terrainStatsEl };
}
