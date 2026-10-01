import { CAR_STATE_STORAGE_KEY } from '../config.js';

// Remembers the local car's last known position/orientation/odometer
// reading across reloads, so the car resumes where it was left off instead
// of always respawning at the world origin. Mirrors ui/lobby.js's
// name/color persistence, and is cleared alongside it via the "Reset saved
// info" help-menu button.
//
// Position/orientation are stored in the *network* frame (the same frame
// published via net.publishPose()) rather than the current view frame, so
// a saved position stays correct even if the player had personally
// teleported (see ui/addressSearch.js) before reloading.

export function loadCarState() {
  try {
    const raw = localStorage.getItem(CAR_STATE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const nums = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'odoKm'];
    if (!parsed || !nums.every((key) => typeof parsed[key] === 'number' && Number.isFinite(parsed[key]))) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCarState(state) {
  try {
    localStorage.setItem(CAR_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable (private browsing, quota, etc.) - not persisting
    // is a harmless degradation, so silently ignore.
  }
}

export function clearCarState() {
  try {
    localStorage.removeItem(CAR_STATE_STORAGE_KEY);
  } catch {
    // Storage unavailable - nothing to clear.
  }
}
