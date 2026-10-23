import { readSaveField, writeSaveField } from './saves.js';

// Remembers the local car's last known position/orientation, km driven
// in this save (odoKm), score, latched handbrake and fuel ({ vehicleId, litres }) in the active game mode's save slot,
// so the car resumes where it was left off instead of always respawning at
// the world origin.
//
// Position/orientation are stored in the *network* frame (the same frame
// published via net.publishPose()) rather than the current view frame, so
// a saved position stays correct even if the player had personally
// teleported (see ui/addressSearch.js) before reloading.

let enabled = true;

/** Off: nothing is loaded or saved (a game mode start that keeps no progress). */
export function setCarStateSaving(on) {
  enabled = on;
}

export function loadCarState() {
  if (!enabled) return null;
  const parsed = readSaveField('carState');
  const nums = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'odoKm'];
  if (!parsed || !nums.every((key) => typeof parsed[key] === 'number' && Number.isFinite(parsed[key]))) return null;
  return parsed;
}

export function saveCarState(state) {
  if (enabled) writeSaveField('carState', state);
}
