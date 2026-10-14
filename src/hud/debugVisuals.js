// M key: toggles all debug visuals together (stats HUDs, tile lines,
// hitboxes, street/river/water overlays).

/**
 * @param {object} deps
 * @param {import('../lib/terrain.js').TerrainManager} deps.terrain
 * @param {import('../lib/buildings.js').BuildingsManager} deps.buildings
 * @param {import('../lib/streets.js').StreetsManager} [deps.streets]
 * @param {import('../lib/rivers.js').RiversManager} [deps.rivers]
 * @param {import('../lib/waterAreas.js').WaterAreasManager} [deps.waterAreas]
 * @param {HTMLElement} deps.terrainStatsEl
 * @param {HTMLElement} deps.suspensionHudEl
 * @param {HTMLElement} [deps.vehicleDebugHudEl]
 * @param {boolean} initialEnabled - on in dev, off in prod
 */
export function createDebugVisualsToggle(
  { terrain, buildings, streets, rivers, waterAreas, terrainStatsEl, suspensionHudEl, vehicleDebugHudEl },
  initialEnabled
) {
  let debugVisualsEnabled = initialEnabled;
  // Set once a car exists; carManager re-applies the state on spawn.
  let setCarHitboxVisible = null;

  function apply() {
    terrainStatsEl.style.display = debugVisualsEnabled ? '' : 'none';
    suspensionHudEl.style.display = debugVisualsEnabled ? '' : 'none';
    if (vehicleDebugHudEl) vehicleDebugHudEl.style.display = debugVisualsEnabled ? '' : 'none';
    terrain.setBordersVisible(debugVisualsEnabled);
    buildings.setHitboxesVisible(debugVisualsEnabled);
    if (streets) streets.setVisible(debugVisualsEnabled);
    if (rivers) rivers.setVisible(debugVisualsEnabled);
    if (waterAreas) waterAreas.setVisible(debugVisualsEnabled);
    if (setCarHitboxVisible) setCarHitboxVisible(debugVisualsEnabled);
  }


  function setEnabled(enabled) {
    debugVisualsEnabled = enabled;
    apply();
  }

  function setCarHitboxSetter(fn) {
    setCarHitboxVisible = fn;
    if (fn) fn(debugVisualsEnabled);
  }

  window.addEventListener('keydown', (e) => {
    const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
    if (typing) return;
    if (e.code === 'KeyM' && !e.repeat) setEnabled(!debugVisualsEnabled);
  });

  apply();

  return {
    isEnabled: () => debugVisualsEnabled,
    setEnabled,
    setCarHitboxSetter,
  };
}
