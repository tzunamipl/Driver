// K key: toggles the debug view (stats HUDs + 3D overlays). The layers panel
// picks which 3D overlays show while it's on; both persist.

import { DEBUG_LAYERS_STORAGE_KEY, DEBUG_VISUALS_STORAGE_KEY } from '../config.js';
import { ROAD_BED_CAUSE_LEGEND } from '../lib/terrain/tileMesh.js';

const LAYERS = [
  { id: 'roads', label: 'Roads', group: 'map' },
  { id: 'water', label: 'Water', group: 'map' },
  { id: 'builtUp', label: 'Built-up areas', group: 'map' },
  { id: 'forest', label: 'Landcover', group: 'map' }, // id kept: saved layer choices
  { id: 'roadBed', label: 'Road bed', group: 'terrain' }, // terrain deformation, not an overlay: off rebuilds detail tiles
  { id: 'tileBorders', label: 'Tile borders', group: 'debug' },
  { id: 'hitboxes', label: 'Hitboxes', group: 'debug' },
  { id: 'terrainGrid', label: 'Terrain polygons', group: 'debug' },
  { id: 'roadProfile', label: 'Road profile', group: 'debug' }, // red = terrain under the centreline, cyan = road height; dots = moved vertices (legend)
  { id: 'roadPolygons', label: 'Road polygons', group: 'debug', on: false }, // triangles of the road stripes (grip / road surface view)
  // Gameplay objects, not overlays: shown while the debug view is off.
  { id: 'roadPosts', label: 'Road posts', group: 'graphics' },
  { id: 'guardRails', label: 'Guard rails', group: 'graphics' },
  { id: 'streetLamps', label: 'Street lamps', group: 'graphics' },
  { id: 'curbs', label: 'Curbs', group: 'graphics' },
  { id: 'curveSigns', label: 'Curve signs', group: 'graphics' },
  { id: 'directionSigns', label: 'Direction signs', group: 'graphics' },
  { id: 'directionSignHud', label: 'Direction sign HUD', group: 'graphics' },
  { id: 'trees', label: 'Trees', group: 'graphics' },
  { id: 'bushes', label: 'Bushes', group: 'graphics' },
  { id: 'rocks', label: 'Rocks', group: 'graphics' },
  { id: 'wheelDust', label: 'Wheel dust', group: 'graphics' },
  { id: 'wheelDebris', label: 'Wheel debris (leaves, stones)', group: 'graphics' },
  { id: 'wetSpray', label: 'Wet road spray', group: 'graphics' },
  { id: 'treeShadows', label: 'Tree, bush & rock shadows', group: 'graphics', on: false }, // debug view only: costly with thousands of trees
  { id: 'dissolve', label: 'Teleport dissolve', group: 'graphics', on: false }, // debug view only: on teleport, tiles, buildings & near trees burst into particles
];
const LAYER_GROUPS = [
  { id: 'map', label: 'Map' },
  { id: 'terrain', label: 'Terrain' },
  { id: 'debug', label: 'Debug' },
  { id: 'graphics', label: 'Graphics' },
];
const ROADSIDE_GROUPS = ['roadPosts', 'guardRails', 'streetLamps', 'curveSigns', 'directionSigns'];

const groupKey = (groupId) => `group:${groupId}`;
// What a Settings toggle in a switched-off group gets back when the group is on again.
const settingKey = (label) => `setting:${label}`;

function loadLayers() {
  const layers = Object.fromEntries(LAYERS.map(({ id, on = true }) => [id, on]));
  for (const { id } of LAYER_GROUPS) layers[groupKey(id)] = true;
  try {
    const saved = JSON.parse(localStorage.getItem(DEBUG_LAYERS_STORAGE_KEY) || '{}');
    for (const [key, value] of Object.entries(saved)) if (typeof value === 'boolean') layers[key] = value;
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
 * @param {ReturnType<import('../lib/dissolve.js').createDissolve>} [deps.dissolve]
 * @param {ReturnType<import('../lib/terrainDust.js').createTerrainDust>} [deps.terrainDust]
 * @param {ReturnType<import('../lib/wheelDebris.js').createWheelDebris>} [deps.wheelDebris]
 * @param {ReturnType<import('../lib/wetSpray.js').createWetSpray>} [deps.wetSpray]
 * @param {HTMLElement} deps.terrainStatsEl
 * @param {HTMLElement} [deps.fpsGraphEl]
 * @param {HTMLElement} deps.suspensionHudEl
 * @param {HTMLElement} [deps.engineHudEl]
 * @param {HTMLElement} [deps.tyreHudEl]
 * @param {HTMLElement} [deps.bodyHudEl]
 * @param {HTMLElement} [deps.brakeHudEl]
 * @param {HTMLElement} [deps.vehicleDebugHudEl]
 * @param {HTMLElement} [deps.layersHudEl] - panel the layer checkboxes go into
 * @param {ReturnType<import('../lib/roadside.js').createRoadside>} [deps.roadside]
 * @param {ReturnType<import('../lib/curbs.js').createCurbs>} [deps.curbs]
 * @param {ReturnType<import('./directionSignHud.js').createDirectionSignHud>} [deps.directionSignHud]
 * @param {{ label: string, toggle: { get(): boolean, set(on: boolean): void, onChange(fn: (on: boolean) => void): void } }[]} [deps.settingToggles]
 *   Settings checkboxes mirrored in the Graphics group (saved by Settings, not with the layers).
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
    dissolve,
    terrainDust,
    wheelDebris,
    wetSpray,
    terrainStatsEl,
    fpsGraphEl,
    suspensionHudEl,
    engineHudEl,
    tyreHudEl,
    bodyHudEl,
    brakeHudEl,
    vehicleDebugHudEl,
    layersHudEl,
    roadside,
    curbs,
    directionSignHud,
    settingToggles = [],
  },
  initialEnabled
) {
  let debugVisualsEnabled = loadEnabled(initialEnabled);
  const layers = loadLayers();
  // Set once a car exists; carManager re-applies the state on spawn.
  let setCarHitboxVisible = null;
  let roadProfileLegend = null;

  // A switched-off group hides its layers but keeps their own choices.
  const groupOf = Object.fromEntries(LAYERS.map(({ id, group }) => [id, group]));
  const isOn = (id) => layers[id] && layers[groupKey(groupOf[id])];
  const shown = (id) => debugVisualsEnabled && isOn(id);
  const kept = (id) => !debugVisualsEnabled || isOn(id);

  function apply() {
    const display = debugVisualsEnabled ? '' : 'none';
    terrainStatsEl.style.display = display;
    if (fpsGraphEl) fpsGraphEl.style.display = display;
    suspensionHudEl.style.display = display;
    if (engineHudEl) engineHudEl.style.display = display;
    if (tyreHudEl) tyreHudEl.style.display = display;
    if (bodyHudEl) bodyHudEl.style.display = display;
    if (brakeHudEl) brakeHudEl.style.display = display;
    if (vehicleDebugHudEl) vehicleDebugHudEl.style.display = display;
    if (layersHudEl) layersHudEl.style.display = display;
    terrain.setBordersVisible(shown('tileBorders'));
    terrain.setWireframeVisible(shown('terrainGrid'));
    terrain.setRoadProfileVisible(shown('roadProfile'));
    if (roadProfileLegend) roadProfileLegend.style.display = isOn('roadProfile') ? '' : 'none';
    terrain.setRoadBedEnabled(kept('roadBed'));
    if (roadside) for (const group of ROADSIDE_GROUPS) roadside.setGroupVisible(group, kept(group));
    if (curbs) curbs.setVisible(kept('curbs'));
    if (directionSignHud) directionSignHud.setEnabled(kept('directionSignHud'));
    buildings.setHitboxesVisible(shown('hitboxes'));
    if (streets) {
      streets.setVisible(shown('roads'));
      streets.setPolygonsVisible(shown('roadPolygons'));
    }
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
    if (dissolve) dissolve.setEnabled(shown('dissolve'));
    if (terrainDust) terrainDust.setEnabled(kept('wheelDust'));
    if (wheelDebris) wheelDebris.setEnabled(kept('wheelDebris'));
    if (wetSpray) wetSpray.setEnabled(kept('wetSpray'));
    if (setCarHitboxVisible) setCarHitboxVisible(shown('hitboxes'));
  }

  function buildLayersPanel() {
    const list = layersHudEl.querySelector('.debug-layers-list') || layersHudEl;
    for (const group of LAYER_GROUPS) {
      const key = groupKey(group.id);
      const { title, groupBox } = groupTitle(group.label);
      groupBox.checked = layers[key];
      const grid = document.createElement('div');
      grid.className = 'debug-layer-grid';
      list.append(title, grid);
      const boxes = [];
      const groupSwitches = []; // Settings toggles follow the group: off with it, back to their box on
      const syncRows = () => {
        grid.classList.toggle('off', !layers[key]);
        for (const box of boxes) box.disabled = !layers[key];
      };
      for (const { id, label } of LAYERS.filter((layer) => layer.group === group.id)) {
        boxes.push(
          layerRow(grid, label, layers[id], (on) => {
            layers[id] = on;
            saveLayers(layers);
            apply();
          })
        );
      }
      if (group.id === 'graphics') {
        for (const { label, toggle } of settingToggles) {
          const memory = settingKey(label);
          if (layers[key]) layers[memory] = toggle.get();
          let muted = false; // our own switch-off while the group is off
          const setSetting = (on) => {
            muted = true;
            toggle.set(on);
            muted = false;
          };
          const box = layerRow(grid, label, layers[memory] ?? toggle.get(), (on) => {
            layers[memory] = on;
            saveLayers(layers);
            setSetting(on);
          });
          toggle.onChange((on) => {
            if (muted) return;
            box.checked = on;
            layers[memory] = on;
            saveLayers(layers);
          });
          boxes.push(box);
          groupSwitches.push((groupOn) => setSetting(groupOn && box.checked));
          if (!layers[key] && toggle.get()) setSetting(false);
        }
      }
      groupBox.addEventListener('change', () => {
        layers[key] = groupBox.checked;
        saveLayers(layers);
        for (const switchSetting of groupSwitches) switchSetting(groupBox.checked);
        apply();
        syncRows();
        groupBox.blur(); // keep keyboard driving working after a click
      });
      syncRows();
      if (group.id === 'debug') {
        roadProfileLegend = buildRoadProfileLegend();
        list.append(roadProfileLegend);
      }
    }
  }

  function groupTitle(label) {
    const title = document.createElement('label');
    title.className = 'debug-layer debug-layer-group';
    const groupBox = document.createElement('input');
    groupBox.type = 'checkbox';
    title.append(groupBox, label);
    return { title, groupBox };
  }

  function layerRow(grid, label, checked, set) {
    const row = document.createElement('label');
    row.className = 'debug-layer';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = checked;
    box.addEventListener('change', () => {
      set(box.checked);
      box.blur(); // keep keyboard driving working after a click
    });
    row.append(box, label);
    grid.append(row);
    return box;
  }

  function buildRoadProfileLegend() {
    const legend = document.createElement('div');
    legend.className = 'debug-legend';
    for (const { cause, color, label } of ROAD_BED_CAUSE_LEGEND) {
      const row = document.createElement('div');
      row.className = 'debug-legend-row';
      const swatch = document.createElement('span');
      swatch.className = cause === 'override' ? 'debug-legend-swatch ring' : 'debug-legend-swatch';
      swatch.style.setProperty('--swatch', color);
      row.append(swatch, label);
      legend.append(row);
    }
    const hint = document.createElement('div');
    hint.className = 'debug-legend-hint';
    hint.textContent = 'Click a dot: lines to the road points it blends';
    legend.append(hint);
    return legend;
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
    if (e.code === 'KeyK' && !e.repeat) setEnabled(!debugVisualsEnabled);
  });

  if (layersHudEl) buildLayersPanel();
  apply();

  return {
    isEnabled: () => debugVisualsEnabled,
    setEnabled,
    setCarHitboxSetter,
  };
}
