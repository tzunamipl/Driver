// Debug visuals toggle (tile stats HUD, 3D tile borders, and collision
// hitbox wireframes for buildings + the car chassis). Press M to hide/show
// all of these together while driving. Kept as its own module since it
// fans out to terrain/buildings/car/HUD elements that otherwise wouldn't
// need to know about each other.

/**
 * @param {object} deps
 * @param {import('../lib/terrain.js').TerrainManager} deps.terrain
 * @param {import('../lib/buildings.js').BuildingsManager} deps.buildings
 * @param {HTMLElement} deps.terrainStatsEl
 * @param {HTMLElement} deps.suspensionHudEl
 * @param {HTMLElement} [deps.vehicleDebugHudEl] - instant vehicle picker
 *   panel (see hud/vehicleDebugPicker.js); optional so tests/other
 *   call sites that don't need it can omit it.
 * @param {boolean} initialEnabled - on by default in dev mode, off by
 *   default in prod (see config.js APP_MODE).
 */
export function createDebugVisualsToggle({ terrain, buildings, terrainStatsEl, suspensionHudEl, vehicleDebugHudEl }, initialEnabled) {
  let debugVisualsEnabled = initialEnabled;
  // Registered later, once the car exists (see carManager.js) - calling
  // setEnabled before that just skips the car hitbox for now; carManager
  // re-applies the current state whenever it (re)spawns a car.
  let setCarHitboxVisible = null;

  function apply() {
    terrainStatsEl.style.display = debugVisualsEnabled ? '' : 'none';
    suspensionHudEl.style.display = debugVisualsEnabled ? '' : 'none';
    if (vehicleDebugHudEl) vehicleDebugHudEl.style.display = debugVisualsEnabled ? '' : 'none';
    terrain.setBordersVisible(debugVisualsEnabled);
    buildings.setHitboxesVisible(debugVisualsEnabled);
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
