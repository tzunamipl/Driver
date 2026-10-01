import { PLAYER_ID_STORAGE_KEY } from '../config.js';

// A stable identifier for this browser's player, persisted across reloads
// so the multiplayer layer (see lib/net.js) doesn't mint a brand-new
// clientId every page load - that would otherwise make every reload look
// like a new peer joining, leaving stale duplicate entries in the remote
// cars list and the "who's online" roster. It's never shown in the UI
// (name/color are what other players see - see ui/lobby.js); it only
// identifies this browser's single persistent slot.
//
// Deliberately kept in its own tiny module (mirrors carState.js) rather
// than folded into the lobby's name/color storage, since it has its own
// lifecycle: it must survive "Reset saved info" (name/color/position are
// meant to reset, but the id shouldn't change underneath an active
// connection) and it's read before the lobby form even exists.
export function loadOrCreatePlayerId() {
  try {
    const existing = localStorage.getItem(PLAYER_ID_STORAGE_KEY);
    if (existing) return existing;
  } catch {
    // Storage unavailable (private browsing, quota, etc.) - fall through
    // to a fresh id that just won't persist.
  }
  const id = crypto.randomUUID();
  try {
    localStorage.setItem(PLAYER_ID_STORAGE_KEY, id);
  } catch {
    // Storage unavailable - the id will be re-generated next reload,
    // which is a harmless degradation.
  }
  return id;
}
