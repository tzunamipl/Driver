// Shared physics constants used by more than one module, so values like
// gravity only have to be tuned in one place instead of being duplicated
// (and risking drifting out of sync) across the world bootstrap and the
// vehicle rigs that estimate loads/forces against it.

// Real-world gravitational acceleration (m/s^2), matching Earth - used both
// to drive the actual CANNON.World gravity (app/physicsSetup.js) and by
// vehicle rigs (lib/car.js) that need this same magnitude to estimate
// static per-wheel load for their suspension-force caps.
export const GRAVITY = 9.82;
