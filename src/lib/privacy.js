import { ANALYTICS_CONSENT_STORAGE_KEY, LEADERBOARD_CONSENT_STORAGE_KEY, EDITOR_PUBLISH_CONSENT_STORAGE_KEY } from '../config.js';

// Player choices on data that leaves the browser: analytics, online leaderboards, editor saves.
// Each is true / false, or null while not asked yet.

export const CONSENTS = {
  analytics: ANALYTICS_CONSENT_STORAGE_KEY,
  leaderboard: LEADERBOARD_CONSENT_STORAGE_KEY,
  editorPublish: EDITOR_PUBLISH_CONSENT_STORAGE_KEY,
};

const listeners = new Set();

/** @param {keyof CONSENTS} kind */
export function getConsent(kind) {
  try {
    const value = localStorage.getItem(CONSENTS[kind]);
    return value === null ? null : value === 'true';
  } catch {
    return null;
  }
}

/** @param {keyof CONSENTS} kind */
export function setConsent(kind, granted) {
  try {
    localStorage.setItem(CONSENTS[kind], String(granted));
  } catch {}
  for (const fn of listeners) fn(kind, granted);
}

/** fn(kind, granted) on every change, e.g. to keep Settings checkboxes in step. */
export function onConsentChange(fn) {
  listeners.add(fn);
}

/** Asked when the first official stage or rally starts; the answer is kept (Settings can change it). */
export function askLeaderboardConsent() {
  const known = getConsent('leaderboard');
  if (known !== null) return known;
  const granted = window.confirm(
    'Send your stage times to the online leaderboard?\n\n' +
      'Your player name, car and times will be stored on the game server and shown publicly on the leaderboards. ' +
      'You can change this later in Settings > Gameplay > Privacy.'
  );
  setConsent('leaderboard', granted);
  return granted;
}

/** Asked before each editor save until accepted once. */
export function askEditorPublishConsent(branch) {
  if (getConsent('editorPublish')) return true;
  const granted = window.confirm(
    'Publish this file?\n\n' +
      `It goes to a public GitHub repository, on a branch named "${branch}" after your player name, ` +
      'with your name in the file and the commit. Git keeps that history, so it cannot be fully removed later.'
  );
  if (granted) setConsent('editorPublish', true);
  return granted;
}
