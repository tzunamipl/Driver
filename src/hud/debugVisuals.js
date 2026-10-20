// M key: toggles the debug view (stats HUDs + 3D overlays). The layers panel
// picks which 3D overlays show while it's on; both persist.

import { DEBUG_LAYERS_STORAGE_KEY, DEBUG_VISUALS_STORAGE_KEY } from '../config.js';

const LAYERS = [
  { id: 'roads', label: 'Roads', group: 'map' },
  { id: 'water', label: 'Water', group: 'map' },
  { id: 'builtUp', label: 'Built-up areas', group: 'map' },
  { id: 'forest', label: 'Landcover', group: 'map' }, // id kept: saved layer choices
  { id: 'tileBorders', label: 'Tile borders', group: 'debug' },
  { id: 'hitboxes', label: 'Hitboxes', group: 'debug' },
  { id: 'terrainGrid', label: 'Terrain polygons', group: 'debug' },
  { id: 'roadProfile', label: 'Road profile', group: 'debug' }, // red = terrain under the centreline, cyan = road height
  { id: 'roadBed', label: 'Road bed', group: 'debug' }, // terrain deformation, not an overlay: off rebuilds detail tiles
  // Gameplay objects, not overlays: shown while the debug view is off.
  { id: 'roadPosts', label: 'Road posts', group: 'graphics' },
  { id: 'streetLamps', label: 'Street lamps', group: 'graphics' },
  { id: 'curveSigns', label: 'Curve signs', group: 'graphics' },
  { id: 'directionSigns', label: 'Direction signs', group: 'graphics' },
  { id: 'directionSignHud', label: 'Direction sign HUD', group: 'graphics' },
  { id: 'trees', label: 'Trees', group: 'graphics' },
  { id: 'bushes', label: 'Bushes', group: 'graphics' },
  { id: 'rocks', label: 'Rocks', group: 'graphics' },
  { id: 'treeShadows', label: 'Tree, bush & rock shadows', group: 'graphics', on: false }, // debug view only: costly with thousands of trees
];
const LAYER_GROUPS = [
  { id: 'map', label: 'Map' },
  { id: 'debug', label: 'Debug' },
  { id: 'graphics', label: 'Graphics' },
];
const ROADSIDE_GROUPS = ['roadPosts', 'streetLamps', 'curveSigns', 'directionSigns'];

function loadLayers() {
  const layers = Object.fromEntries(LAYERS.map(({ id, on = true }) => [id, on]));
  try {
    const saved = JSON.parse(localStorage.getItem(DEBUG_LAYERS_STORAGE_KEY) || '{}');
    for (const { id } of LAYERS) if (typeof saved[id] === 'boolean') layers[id] = saved[id];
  } catch {
    // Corrupt/unavailable storage: defaults.
  }
  return layers;
}

function saveLayers(layers) {
  try {
    localStorage.setItem(DEBUG_LAYERS_STORAGE_KEY, JSON.stringify(layers));
  } catch {
    // Storage unavailable: just don't persist.
  }
}

function loadEnabled(fallback) {
  try {
    const saved = localStorage.getItem(DEBUG_VISUALS_STORAGE_KEY);
    if (saved === 'on' || saved === 'off') return saved === 'on';
  } catch {
    // Storage unavailable: use the mode default.
  }
  return fallback;
}

function saveEnabled(enabled) {
  try {
    localStorage.setItem(DEBUG_VISUALS_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Storage unavailable: just don't persist.
  }
}

/**
 * @param {object} deps
 * @param {import('../lib/terrain.js').TerrainManager} deps.terrain
 * @param {import('../lib/buildings.js').BuildingsManager} deps.buildings
 * @param {import('../lib/streets.js').StreetsManager} [deps.streets]
 * @param {import('../lib/rivers.js').RiversManager} [deps.rivers]
 * @param {import('../lib/waterAreas.js').WaterAreasManager} [deps.waterAreas]
 * @param {import('../lib/builtUpAreas.js').BuiltUpAreasManager} [deps.builtUpAreas]
 * @param {import('../lib/landcoverAreas.js').LandcoverAreasManager} [deps.landcoverAreas]
 * @param {ReturnType<import('../lib/trees.js').createTrees>} [deps.trees]
 * @param {ReturnType<import('../lib/trees.js').createBushes>} [deps.bushes]
 * @param {ReturnType<import('../lib/trees.js').createRocks>} [deps.rocks]
 * @param {HTMLElement} deps.terrainStatsEl
 * @param {HTMLElement} deps.suspensionHudEl
 * @param {HTMLElement} [deps.vehicleDebugHudEl]
 * @param {HTMLElement} [deps.layersHudEl] - panel the layer checkboxes go into
 * @param {ReturnType<import('../lib/roadside.js').createRoadside>} [deps.roadside]
 * @param {ReturnType<import('./directionSignHud.js').createDirectionSignHud>} [deps.directionSignHud]
 * @param {boolean} initialEnabled - default when nothing is saved: on in dev, off in prod
 */
export function createDebugVisualsToggle(
  {
    terrain,
    buildings,
    streets,
    rivers,
    waterAreas,
    builtUpAreas,
    landcoverAreas,
    trees,
    bushes,
    rocks,
    terrainStatsEl,
    suspensionHudEl,
    vehicleDebugHudEl,
    layersHudEl,
    roadside,
    directionSignHud,
  },
  initialEnabled
) {
  let debugVisualsEnabled = loadEnabled(initialEnabled);
  const layers = loadLayers();
  // Set once a car exists; carManager re-applies the state on spawn.
  let setCarHitboxVisible = null;

  const shown = (id) => debugVisualsEnabled && layers[id];
  const kept = (id) => !debugVisualsEnabled || layers[id];

  function apply() {
    const display = debugVisualsEnabled ? '' : 'none';
    terrainStatsEl.style.display = display;
    suspensionHudEl.style.display = display;
    if (vehicleDebugHudEl) vehicleDebugHudEl.style.display = display;
    if (layersHudEl) layersHudEl.style.display = display;
    terrain.setBordersVisible(shown('tileBorders'));
    terrain.setWireframeVisible(shown('terrainGrid'));
    terrain.setRoadProfileVisible(shown('roadProfile'));
    terrain.setRoadBedEnabled(kept('roadBed'));
    if (roadside) for (const group of ROADSIDE_GROUPS) roadside.setGroupVisible(group, kept(group));
    if (directionSignHud) directionSignHud.setEnabled(kept('directionSignHud'));
    buildings.setHitboxesVisible(shown('hitboxes'));
    if (streets) streets.setVisible(shown('roads'));
    if (rivers) rivers.setVisible(shown('water'));
    if (waterAreas) waterAreas.setVisible(shown('water'));
    if (builtUpAreas) builtUpAreas.setVisible(shown('builtUp'));
    if (landcoverAreas) landcoverAreas.setVisible(shown('forest'));
    if (trees) {
      trees.setVisible(kept('trees'));
      trees.setShadows(shown('treeShadows'));
    }
    if (bushes) {
      bushes.setVisible(kept('bushes'));
      bushes.setShadows(shown('treeShadows'));
    }
    if (rocks) {
      rocks.setVisible(kept('rocks'));
      rocks.setShadows(shown('treeShadows'));
    }
    if (setCarHitboxVisible) setCarHitboxVisible(shown('hitboxes'));
  }

  function buildLayersPanel() {
    const list = layersHudEl.querySelector('.debug-layers-list') || layersHudEl;
    for (const group of LAYER_GROUPS) {
      const title = document.createElement('div');
      title.className = 'debug-layer-group';
      title.textContent = group.label;
      const grid = document.createElement('div');
      grid.className = 'debug-layer-grid';
      list.append(title, grid);
      for (const { id, label } of LAYERS.filter((layer) => layer.group === group.id)) {
        const row = document.createElement('label');
        row.className = 'debug-layer';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = layers[id];
        box.addEventListener('change', () => {
          layers[id] = box.checked;
          saveLayers(layers);
          apply();
          box.blur(); // keep keyboard driving working after a click
        });
        row.append(box, label);
        grid.append(row);
      }
    }
  }

  function setEnabled(enabled) {
    debugVisualsEnabled = enabled;
    saveEnabled(enabled);
    apply();
  }

  function setCarHitboxSetter(fn) {
    setCarHitboxVisible = fn;
    if (fn) fn(shown('hitboxes'));
  }

  window.addEventListener('keydown', (e) => {
    const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
    if (typing) return;
    if (e.code === 'KeyM' && !e.repeat) setEnabled(!debugVisualsEnabled);
  });

  if (layersHudEl) buildLayersPanel();
  apply();

  return {
    isEnabled: () => debugVisualsEnabled,
    setEnabled,
    setCarHitboxSetter,
  };
}
