import { DIRECTIONS, STATS_UPDATE_INTERVAL } from '../config.js';
import { computeHeadingDeg, headingDirection } from '../lib/heading.js';

// Debug-only streaming stats HUD (memory + tile map); skipped when off.

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A tile with terrain loaded shows 4 triangles (terrain / streets /
// water / buildings), each yellow until that layer is built, then green.
const PENDING_COLOR = '#ffc107';
const TERRAIN_DETAIL_COLORS = { high: '#39ff14', medium: '#2e8b22', low: '#6f8f6a' };
// Terrain quadrant of a tile with max-zoom imagery; an outline while it's still queued.
const MAX_IMAGERY_COLOR = '#00e5ff';
// Outline of a tile whose elevation source had no data (a coarser zoom stands in).
const ELEVATION_FALLBACK_COLOR = '#ff00ff';

/**
 * conic-gradient "X" split of a cell into 4 quadrants. Layers that never
 * load on this tile's detail level (streets/water: HIGH only, buildings:
 * up to MEDIUM) count as complete.
 */
function quadrantBackground(cell, buildings, streets, rivers, waterAreas) {
  const doneColor = TERRAIN_DETAIL_COLORS[cell.level] || TERRAIN_DETAIL_COLORS.medium;
  const isHigh = cell.level === 'high';
  const isLow = cell.level === 'low';
  const streetsDone = isHigh ? !!streets?.isTileLoaded?.(cell.tx, cell.ty) : true;
  // Rivers + water polygons share one quadrant.
  const riversDone = isHigh
    ? !!rivers?.isTileLoaded?.(cell.tx, cell.ty) && !!waterAreas?.isTileLoaded?.(cell.tx, cell.ty)
    : true;
  const buildingsDone = isLow ? true : !!buildings?.isTileLoaded?.(cell.tx, cell.ty);
  // Terrain is implicitly done for any 'loaded' cell.
  const terrainColor = cell.maxImagery === 'loaded' ? MAX_IMAGERY_COLOR : doneColor;
  const streetsColor = streetsDone ? doneColor : PENDING_COLOR;
  const riversColor = riversDone ? doneColor : PENDING_COLOR;
  const buildingsColor = buildingsDone ? doneColor : PENDING_COLOR;
  return (
    `conic-gradient(from -45deg, ${terrainColor} 0turn 0.25turn, ${streetsColor} 0.25turn 0.5turn, ` +
    `${riversColor} 0.5turn 0.75turn, ${buildingsColor} 0.75turn 1turn)`
  );
}

function formatCount(n) {
  return n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`;
}

export function createTerrainStatsHud() {
  const terrainStatsEl = document.getElementById('terrain-stats');
  let statsAccum = 0;
  let fps = 0;
  let fpsAccum = 0;
  let fpsFrames = 0;

  function updateTerrainStats(
    delta,
    { terrain, buildings, streets, rivers, waterAreas, builtUpAreas, chassisMesh, debugVisualsEnabled, pedestrians, viewFrame, roadside, trees, bushes, rocks }
  ) {
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
    // Copyable coordinates in the network frame (same as carState.js);
    // elevation adds the terrain height baseline back.
    let coordsText = '';
    if (viewFrame) {
      const { lat, lon } = viewFrame.toLatLon(chassisMesh.position.x, chassisMesh.position.z);
      const elevation = chassisMesh.position.y + terrain.heightOffset;
      coordsText = `${lat.toFixed(6)}, ${lon.toFixed(6)} \u2022 ${elevation.toFixed(1)} m asl`;
    }
    const textLines = [
      'TERRAIN',
      `fps: ${fps.toFixed(0)}`,
      `detail: ${s.loaded} loaded  ${s.pending} loading  ${s.pendingRemoval} hidden`,
      `coarse: ${s.far.loaded} loaded  ${s.far.pending} loading  ${s.far.pendingRemoval} hidden`,
      `created: ${s.created}/${s.far.created}  removed: ${s.removed}/${s.far.removed}`,
      `~memory: ${formatBytes(s.memoryBytes + s.far.memoryBytes)}`,
      `triangles: ${formatCount(s.triangles)}`,
      `ahead: ${aheadTx},${aheadTy}`,
      `buildings: ${b.buildings} in ${b.loaded} tiles${b.building ? ` (${b.building} building\u2026)` : ''}` +
        `${b.regionLoading ? ' (region loading\u2026)' : ''}  ~${formatBytes(b.memoryBytes)}`,
      `far buildings: ${b.far.instances} boxes in ${b.far.tiles} tiles${b.far.pending ? ` (${b.far.pending} loading\u2026)` : ''}` +
        `  ~${formatBytes(b.far.memoryBytes)}`,
    ];
    if (roadside) {
      const counts = Object.entries(roadside.getCounts());
      const total = counts.reduce((sum, [, n]) => sum + n, 0);
      textLines.push(`doodads: ${total}  (${counts.map(([group, n]) => `${group} ${n}`).join(', ')})`);
    }
    if (trees && bushes && rocks) {
      const [t, b, r] = [trees, bushes, rocks].map((v) => v.getCount());
      textLines.push(`foliage: ${t + b + r}  (trees ${t}, bushes ${b}, rocks ${r})`);
    }
    if (builtUpAreas) {
      const { x, z } = chassisMesh.position;
      const landuse = builtUpAreas.classifyAt(x, z);
      const zone = builtUpAreas.isBuiltUpAt(x, z) ? 'built-up' : 'open';
      textLines.push(`zone: ${zone}${landuse ? ` (${landuse})` : ''}`);
    }
    if (s.stray) textLines.push(`stray tiles (off-grid): ${s.stray}`);
    if (s.elevationFallbacks) textLines.push(`elevation no-data: ${s.elevationFallbacks} tiles (coarser zoom used)`);
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
      (coordsText ? `<div class="ts-coords" title="Current position - selectable to copy">${coordsText}</div>` : '') +
      `<div class="ts-compass-wrap">` +
      `<span class="ts-dir n">N</span><span class="ts-dir s">S</span>` +
      `<span class="ts-dir w">W</span><span class="ts-dir e">E</span>` +
      `<div class="ts-grid" style="grid-template-columns: repeat(${cols}, 5px)">` +
      s.grid
        .map((row) =>
          row
            .map((cell) => {
              const isPlayer = cell.state === 'player';
              const cellState = isPlayer ? 'loaded' : cell.state;
              const classes = ['ts-cell', cellState];
              if (isPlayer) classes.push('player');
              // Terrain loaded: show the per-layer quadrant progress.
              const styles = [];
              if (cellState === 'loaded') styles.push(`background:${quadrantBackground(cell, buildings, streets, rivers, waterAreas)}`);
              const outline = cell.elevationFallback ? ELEVATION_FALLBACK_COLOR : cell.maxImagery === 'planned' ? MAX_IMAGERY_COLOR : null;
              if (outline) styles.push(`box-shadow:inset 0 0 0 1px ${outline}${isPlayer ? ', 0 0 4px #fff' : ''}`);
              const style = styles.length ? ` style="${styles.join(';')}"` : '';
              const glyph = isPlayer ? dir.arrow : '';
              return `<span class="${classes.join(' ')}"${style}>${glyph}</span>`;
            })
            .join('')
        )
        .join('') +
      `</div></div>` +
      `<div class="ts-legend">` +
      `<span><span class="swatch" style="background:${TERRAIN_DETAIL_COLORS.high}"></span>high detail</span>` +
      `<span><span class="swatch" style="background:${TERRAIN_DETAIL_COLORS.medium}"></span>medium detail</span>` +
      `<span><span class="swatch" style="background:${TERRAIN_DETAIL_COLORS.low}"></span>low detail</span>` +
      `<span><span class="swatch" style="background:${MAX_IMAGERY_COLOR}"></span>max-zoom photo (outline: queued)</span>` +
      `<span><span class="swatch" style="background:${ELEVATION_FALLBACK_COLOR}"></span>outline: elevation no-data</span>` +
      `<span><span class="swatch" style="background:${PENDING_COLOR}"></span>pending/planned</span>` +
      `<span><span class="swatch" style="background:rgba(244,67,54,0.55)"></span>hidden</span>` +
      `<span><span class="swatch" style="background:rgba(255,255,255,0.1)"></span>empty</span>` +
      `<span>${dir.arrow} you</span>` +
      `</div>`;
  }

  return { updateTerrainStats, el: terrainStatsEl };
}

