import { readSaveField, writeSaveField } from './saves.js';

// Remembers the local car's last known position/orientation/odometer
// reading, score and latched handbrake in the active game mode's save slot,
// so the car resumes where it was left off instead of always respawning at
// the world origin.
//
// Position/orientation are stored in the *network* frame (the same frame
// published via net.publishPose()) rather than the current view frame, so
// a saved position stays correct even if the player had personally
// teleported (see ui/addressSearch.js) before reloading.

export function loadCarState() {
  const parsed = readSaveField('carState');
  const nums = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'odoKm'];
  if (!parsed || !nums.every((key) => typeof parsed[key] === 'number' && Number.isFinite(parsed[key]))) return null;
  return parsed;
}

export function saveCarState(state) {
  writeSaveField('carState', state);
}
