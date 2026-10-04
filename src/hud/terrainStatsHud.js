import { DIRECTIONS, STATS_UPDATE_INTERVAL } from '../config.js';
import { computeHeadingDeg, headingDirection } from '../lib/heading.js';
import { localToLatLon } from '../lib/geo.js';

// Terrain/buildings streaming stats HUD (memory usage + tile streaming
// map). Debug-only overlay; disabled outright when debug visuals are off
// so its (relatively expensive) DOM rebuild never runs during normal play.

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Per-tile loading progress is shown as a square split by both diagonals
// into 4 triangles (one per loaded asset - see quadrantBackground below),
// each one yellow (not loaded yet) until its asset actually finishes
// building, then switching to green (the same detail-level green as
// before, just filled in one quadrant at a time instead of all at once).
// A cell that hasn't even got terrain yet stays flat yellow (the
// 'pending' state below, no quadrants) - only once terrain exists does
// the cell start showing (and filling in) its quadrant breakdown,
// mirroring the real load order (terrain, then roads/rivers, then
// buildings - see mainLoop.js).
const PENDING_COLOR = '#ffc107';
const TERRAIN_DETAIL_COLORS = { high: '#39ff14', medium: '#2e8b22', low: '#6f8f6a' };

/**
 * Builds a CSS conic-gradient splitting a cell into 4 triangles (top/
 * right/bottom/left, via a -45deg-rotated 4-stop conic-gradient - the
 * standard trick for an "X"-divided square) representing terrain/streets/
 * rivers/buildings respectively. Each quadrant is yellow until its asset
 * finishes loading, then switches to the cell's detail-level green -
 * streets/rivers only ever load for HIGH-detail tiles, and buildings only
 * loads out to MEDIUM (i.e. terrain.js's DETAIL_RADIUS - LOW tiles are a
 * terrain-only outer ring, see terrain.js's DetailLevel doc comment), so
 * for any tile those quadrants will never actually load on, they're
 * treated as already "complete" rather than permanently stuck yellow for
 * content that will never be fetched there.
 */
function quadrantBackground(cell, buildings, streets, rivers, waterAreas) {
  const doneColor = TERRAIN_DETAIL_COLORS[cell.level] || TERRAIN_DETAIL_COLORS.medium;
  const isHigh = cell.level === 'high';
  const isLow = cell.level === 'low';
  const streetsDone = isHigh ? !!streets?.isTileLoaded?.(cell.tx, cell.ty) : true;
  // Both rivers.js (waterway centerlines) and waterAreas.js (water
  // polygons) are "the water debug overlay" from this HUD's perspective -
  // folded into one quadrant rather than growing the 4-quadrant layout.
  const riversDone = isHigh
    ? !!rivers?.isTileLoaded?.(cell.tx, cell.ty) && !!waterAreas?.isTileLoaded?.(cell.tx, cell.ty)
    : true;
  const buildingsDone = isLow ? true : !!buildings?.isTileLoaded?.(cell.tx, cell.ty);
  const terrainColor = doneColor; // terrain is implicitly done for any 'loaded' cell
  const streetsColor = streetsDone ? doneColor : PENDING_COLOR;
  const riversColor = riversDone ? doneColor : PENDING_COLOR;
  const buildingsColor = buildingsDone ? doneColor : PENDING_COLOR;
  return (
    `conic-gradient(from -45deg, ${terrainColor} 0turn 0.25turn, ${streetsColor} 0.25turn 0.5turn, ` +
    `${riversColor} 0.5turn 0.75turn, ${buildingsColor} 0.75turn 1turn)`
  );
}

export function createTerrainStatsHud() {
  const terrainStatsEl = document.getElementById('terrain-stats');
  let statsAccum = 0;
  let fps = 0;
  let fpsAccum = 0;
  let fpsFrames = 0;

  function updateTerrainStats(
    delta,
    { terrain, buildings, streets, rivers, waterAreas, chassisMesh, debugVisualsEnabled, pedestrians, viewOriginLat, viewOriginLon }
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
    // Selectable (copy/paste-able) coordinates for bug reports / manually
    // navigating elsewhere - computed in the *network* frame (same frame
    // carState.js persists, independent of any personal teleport) so a
    // pasted value stays meaningful even after reloading. Elevation is the
    // real-world height above sea level - chassisMesh.position.y is
    // relative to the origin's height baseline (see terrain.js's
    // heightOffset), so that baseline is added back in.
    let coordsText = '';
    if (Number.isFinite(viewOriginLat) && Number.isFinite(viewOriginLon)) {
      const { lat, lon } = localToLatLon(chassisMesh.position.x, chassisMesh.position.z, viewOriginLat, viewOriginLon);
      const elevation = chassisMesh.position.y + terrain.heightOffset;
      coordsText = `${lat.toFixed(6)}, ${lon.toFixed(6)} \u2022 ${elevation.toFixed(1)} m asl`;
    }
    const textLines = [
      'TERRAIN',
      `fps: ${fps.toFixed(0)}`,
      `detail: ${s.loaded} loaded  ${s.pending} loading  ${s.pendingRemoval} removing`,
      `far:    ${s.far.loaded} loaded  ${s.far.pending} loading  ${s.far.pendingRemoval} removing`,
      `created: ${s.created}/${s.far.created}  removed: ${s.removed}/${s.far.removed}`,
      `~memory: ${formatBytes(s.memoryBytes + s.far.memoryBytes)}`,
      `ahead: ${aheadTx},${aheadTy}`,
      `buildings: ${b.buildings} in ${b.loaded} tiles${b.building ? ` (${b.building} building\u2026)` : ''}` +
        `${b.regionLoading ? ' (region loading\u2026)' : ''}  ~${formatBytes(b.memoryBytes)}`,
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
      (coordsText ? `<div class="ts-coords" title="Current position - selectable to copy">${coordsText}</div>` : '') +
      `<div class="ts-compass-wrap">` +
      `<span class="ts-dir n">N</span><span class="ts-dir s">S</span>` +
      `<span class="ts-dir w">W</span><span class="ts-dir e">E</span>` +
      `<div class="ts-grid" style="grid-template-columns: repeat(${cols}, 8px)">` +
      s.grid
        .map((row) =>
          row
            .map((cell) => {
              const isPlayer = cell.state === 'player';
              const cellState = isPlayer ? 'loaded' : cell.state;
              const classes = ['ts-cell', cellState];
              if (isPlayer) classes.push('player');
              // Once terrain itself is loaded (including the player's own
              // tile, which is always loaded by definition), replace the
              // flat per-state background with the 4-quadrant progress
              // indicator (see quadrantBackground) showing terrain/roads/
              // rivers/buildings loading progress for that specific tile.
              const style =
                cellState === 'loaded' ? ` style="background:${quadrantBackground(cell, buildings, streets, rivers, waterAreas)}"` : '';
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
      `<span><span class="swatch" style="background:${PENDING_COLOR}"></span>pending/planned</span>` +
      `<span><span class="swatch" style="background:rgba(244,67,54,0.55)"></span>removing</span>` +
      `<span><span class="swatch" style="background:rgba(255,255,255,0.1)"></span>empty</span>` +
      `<span>${dir.arrow} you</span>` +
      `</div>`;
  }

  return { updateTerrainStats, el: terrainStatsEl };
}

