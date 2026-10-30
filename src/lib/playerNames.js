import { IS_DEV_MODE } from '../config.js';

// Forbidden player names, keyed by normalized form → true (never allowed) or 'dev' (dev mode only).
const FORBIDDEN_PLAYER_NAMES = {
  devmode: 'dev',
};

// Case, spaces and separators don't count: "Dev-Mode" = "dev_mode".
const normalize = (name) => String(name ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** True when this name can't be used in the current app mode. */
export function isForbiddenPlayerName(name) {
  const rule = FORBIDDEN_PLAYER_NAMES[normalize(name)];
  return rule === true || (rule === 'dev' && !IS_DEV_MODE);
}
