// Settings "Detail level" select: low / medium / high, remembered in localStorage.

import { DEFAULT_GRAPHICS_DETAIL, GRAPHICS_DETAIL_LEVELS, GRAPHICS_DETAIL_STORAGE_KEY } from '../config.js';
import { setGlintsEnabled } from '../lib/lampGlints.js';
import { setParticleShare } from '../lib/particles/particleDetail.js';

/** Fills the select now (the main menu shows it before the world exists); `bind` applies levels. */
export function createGraphicsDetailPicker() {
  const select = document.getElementById('graphics-detail-select');
  for (const [id, { label }] of Object.entries(GRAPHICS_DETAIL_LEVELS)) select.add(new Option(label, id));
  select.value = readLevel();
  let targets = null;

  function apply(id) {
    if (!targets) return;
    const { terrain, mainLoop, roadside, curbs, trees, bushes, rocks, buildings, shadowLights, streetLights, exhaustFlames, setAntialias, colorGrade } = targets;
    const level = GRAPHICS_DETAIL_LEVELS[id];
    terrain.setDetailCells(level.terrainCells, level.terrainNearCells, level.terrainSuperCells);
    mainLoop.setStreamingBudgetMs(level.streamingBudgetMs);
    roadside.setDrawDistance(level.roadsideDrawDistance);
    curbs.setDrawDistance(level.roadsideDrawDistance);
    trees.setDetail(level.trees);
    bushes.setDetail(level.bushes);
    rocks.setDetail(level.rocks);
    setGlintsEnabled(level.lampGlints);
    setParticleShare(level.particles);
    // Changing the shadow-casting light count recompiles every lit material on its next draw.
    for (const light of shadowLights) light.castShadow = level.shadows;
    streetLights.setEnabled(level.lights);
    exhaustFlames.setFlashLight(level.lights);
    setAntialias(level.antialias);
    colorGrade?.setEnabled(level.colorGrade);
    buildings.setFarRadius(level.farBuildingsM);
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
