// Gearbox wear for engine.js: health 1 new .. 0 wrecked. Over-rev downshifts
// (the wheels spin the engine past redline as the gear goes in) and hard hits
// take health; a worn box shifts slower, up to SLOWEST_SHIFT_FACTOR x stock.

const SLOWEST_SHIFT_FACTOR = 5;
// Engaged-gear rpm / redline that starts to hurt, and the one that takes OVERREV_MAX_WEAR.
const OVERREV_MIN_RATIO = 1.05;
const OVERREV_FULL_RATIO = 1.6;
const OVERREV_MAX_WEAR = 0.6;
// Impact speed (m/s, along the contact normal) that starts to hurt, and the one that takes HIT_MAX_WEAR.
const HIT_MIN_MS = 8;
const HIT_FULL_MS = 25;
const HIT_MAX_WEAR = 0.5;
// One crash fires contacts over several steps: within this window only the hardest one counts.
const HIT_WINDOW_S = 0.5;
const DEBUG_WEAR = 0.25;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function createGearboxWear() {
  let clock = 0; // s of tick() time
  let hitUntil = -Infinity;
  let hitSeverity = 0; // hardest hit in the current window

  const gearbox = {
    health: 1,
    /** Multiplier on the stock shift time (and manual synchro time). */
    get shiftFactor() {
      return 1 + (SLOWEST_SHIFT_FACTOR - 1) * (1 - gearbox.health);
    },
    tick,
    overRev,
    hit,
    wear,
    repair,
    getState,
    setState,
  };

  function tick(dt) {
    clock += dt;
  }

  function wear(amount = DEBUG_WEAR) {
    gearbox.health = clamp01(gearbox.health - amount);
  }

  /** A gear went in with the wheels demanding `rpmRatio` x redline. */
  function overRev(rpmRatio) {
    wear(clamp01((rpmRatio - OVERREV_MIN_RATIO) / (OVERREV_FULL_RATIO - OVERREV_MIN_RATIO)) * OVERREV_MAX_WEAR);
  }

  /** Body impact at `speedMs` along the contact normal. */
  function hit(speedMs) {
    const severity = clamp01((speedMs - HIT_MIN_MS) / (HIT_FULL_MS - HIT_MIN_MS));
    if (severity <= 0) return;
    if (clock > hitUntil) hitSeverity = 0;
    hitUntil = clock + HIT_WINDOW_S;
    if (severity <= hitSeverity) return;
    wear((severity - hitSeverity) * HIT_MAX_WEAR);
    hitSeverity = severity;
  }

  function repair() {
    gearbox.health = 1;
    hitSeverity = 0;
  }

  function getState() {
    return gearbox.health;
  }

  function setState(health) {
    if (Number.isFinite(health)) gearbox.health = clamp01(health);
  }

  return gearbox;
}
