// M key: toggles the debug view (stats HUDs + 3D overlays). The layers panel
// picks which 3D overlays show while it's on; both persist.

import { DEBUG_LAYERS_STORAGE_KEY, DEBUG_VISUALS_STORAGE_KEY } from '../config.js';

const LAYERS = [
  { id: 'roads', label: 'Roads' },
  { id: 'water', label: 'Water' },
  { id: 'builtUp', label: 'Built-up areas' },
  { id: 'tileBorders', label: 'Tile borders' },
  { id: 'hitboxes', label: 'Hitboxes' },
  { id: 'terrainGrid', label: 'Terrain polygons' },
  { id: 'roadProfile', label: 'Road profile' }, // red = terrain under the centreline, cyan = road height
  { id: 'roadBed', label: 'Road bed' }, // terrain deformation, not an overlay: off rebuilds detail tiles
];

function loadLayers() {
  const layers = Object.fromEntries(LAYERS.map(({ id }) => [id, true]));
  try {
    const saved = JSON.parse(localStorage.getItem(DEBUG_LAYERS_STORAGE_KEY) || '{}');
    for (const { id } of LAYERS) if (typeof saved[id] === 'boolean') layers[id] = saved[id];
  } catch {
    // Corrupt/unavailable storage: all layers on.
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
 * @param {HTMLElement} deps.terrainStatsEl
 * @param {HTMLElement} deps.suspensionHudEl
 * @param {HTMLElement} [deps.vehicleDebugHudEl]
 * @param {HTMLElement} [deps.layersHudEl] - panel the layer checkboxes go into
 * @param {boolean} initialEnabled - default when nothing is saved: on in dev, off in prod
 */
export function createDebugVisualsToggle(
  { terrain, buildings, streets, rivers, waterAreas, builtUpAreas, terrainStatsEl, suspensionHudEl, vehicleDebugHudEl, layersHudEl },
  initialEnabled
) {
  let debugVisualsEnabled = loadEnabled(initialEnabled);
  const layers = loadLayers();
  // Set once a car exists; carManager re-applies the state on spawn.
  let setCarHitboxVisible = null;

  const shown = (id) => debugVisualsEnabled && layers[id];

  function apply() {
    const display = debugVisualsEnabled ? '' : 'none';
    terrainStatsEl.style.display = display;
    suspensionHudEl.style.display = display;
    if (vehicleDebugHudEl) vehicleDebugHudEl.style.display = display;
    if (layersHudEl) layersHudEl.style.display = display;
    terrain.setBordersVisible(shown('tileBorders'));
    terrain.setWireframeVisible(shown('terrainGrid'));
    terrain.setRoadProfileVisible(shown('roadProfile'));
    terrain.setRoadBedEnabled(!debugVisualsEnabled || layers.roadBed);
    buildings.setHitboxesVisible(shown('hitboxes'));
    if (streets) streets.setVisible(shown('roads'));
    if (rivers) rivers.setVisible(shown('water'));
    if (waterAreas) waterAreas.setVisible(shown('water'));
    if (builtUpAreas) builtUpAreas.setVisible(shown('builtUp'));
    if (setCarHitboxVisible) setCarHitboxVisible(shown('hitboxes'));
  }

  function buildLayersPanel() {
    const list = layersHudEl.querySelector('.debug-layers-list') || layersHudEl;
    for (const { id, label } of LAYERS) {
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
      list.append(row);
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
