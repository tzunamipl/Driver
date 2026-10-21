// Settings "Detail level" select: low / medium / high, remembered in localStorage.

import { DEFAULT_GRAPHICS_DETAIL, GRAPHICS_DETAIL_LEVELS, GRAPHICS_DETAIL_STORAGE_KEY } from '../config.js';

/** Fills the select now (the main menu shows it before the world exists); `bind` applies levels. */
export function createGraphicsDetailPicker() {
  const select = document.getElementById('graphics-detail-select');
  for (const [id, { label }] of Object.entries(GRAPHICS_DETAIL_LEVELS)) select.add(new Option(label, id));
  select.value = readLevel();
  let targets = null;

  function apply(id) {
    if (!targets) return;
    const { terrain, mainLoop, roadside, trees, bushes, rocks } = targets;
    const level = GRAPHICS_DETAIL_LEVELS[id];
    terrain.setDetailCells(level.terrainCells);
    mainLoop.setStreamingBudgetMs(level.streamingBudgetMs);
    roadside.setDrawDistance(level.roadsideDrawDistance);
    trees.setDetail(level.trees);
    bushes.setDetail(level.bushes);
    rocks.setDetail(level.rocks);
  }

  select.addEventListener('change', () => {
    try { localStorage.setItem(GRAPHICS_DETAIL_STORAGE_KEY, select.value); } catch { /* private mode */ }
    apply(select.value);
    select.blur(); // arrow keys steer, not change the level
  });

  return {
    /** Applies the selected level now and on every change. */
    bind(subsystems) {
      targets = subsystems;
      apply(select.value);
    },
  };
}

function readLevel() {
  try {
    const id = localStorage.getItem(GRAPHICS_DETAIL_STORAGE_KEY);
    return id in GRAPHICS_DETAIL_LEVELS ? id : DEFAULT_GRAPHICS_DETAIL;
  } catch {
    return DEFAULT_GRAPHICS_DETAIL;
  }
}
