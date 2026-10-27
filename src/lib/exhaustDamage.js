// Exhaust health: 1 new .. 0 fallen off. Tail hits and floor strikes (harder on the rear
// half, where the pipe runs) take health, and so does a loose pipe dragging on the ground
// (exhaustPipes.js). Gone, it costs LOST_POWER_FACTOR of the torque (engine.powerFactor
// in car.js) and the engine sound turns raw (audio/engine.js). A car without an exhaust
// system (descriptor `breakableExhaust: false`) keeps it at 1.

const LOST_POWER_FACTOR = 0.8;
// Impact speed (m/s, along the contact normal) that starts to hurt, and the one that takes HIT_MAX_WEAR.
const TAIL_MIN_MS = 4;
const TAIL_FULL_MS = 14;
const UNDER_MIN_MS = 3;
const UNDER_FULL_MS = 12;
const HIT_MAX_WEAR = 0.6;
const FRONT_UNDER_SHARE = 0.4; // floor strikes ahead of the middle mostly miss the pipe
// One crash fires contacts over several steps: within this window only the hardest one counts.
const HIT_WINDOW_S = 0.5;
const SCRAPE_WEAR_PER_M = 0.0015;
const DEBUG_WEAR = 0.25;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function createExhaustDamage({ breakable = true } = {}) {
  let hitUntil = -Infinity;
  let hitSeverity = 0; // hardest hit in the current window

  const exhaust = {
    health: 1,
    breakable, // false: nothing to wear, repair or drop
    noWear: false, // editor: hits and scraping leave it alone
    repairRecord: null, // lib/partRepair.js record, cleared by a new exhaust
    anchor: null, // chassis-local [x, y, z] for app/partCallouts.js, set by exhaustPipes.js
    get detached() {
      return exhaust.health <= 0;
    },
    get powerFactor() {
      return exhaust.detached ? LOST_POWER_FACTOR : 1;
    },
    hit,
    scrape,
    wear,
    repair,
    getState,
    setState,
  };

  function wear(amount = DEBUG_WEAR) {
    if (exhaust.noWear || !breakable) return;
    exhaust.health = clamp01(exhaust.health - amount);
  }

  /** collisions.js endImpact() of a chassis contact. */
  function hit({ end, under, z, speed }) {
    let severity = 0;
    if (end === -1) severity = clamp01((speed - TAIL_MIN_MS) / (TAIL_FULL_MS - TAIL_MIN_MS));
    if (under) severity = Math.max(severity, clamp01((speed - UNDER_MIN_MS) / (UNDER_FULL_MS - UNDER_MIN_MS)) * (z > 0 ? FRONT_UNDER_SHARE : 1));
    if (severity <= 0) return;
    const clock = performance.now() / 1000;
    if (clock > hitUntil) hitSeverity = 0;
    hitUntil = clock + HIT_WINDOW_S;
    if (severity <= hitSeverity) return;
    wear((severity - hitSeverity) * HIT_MAX_WEAR);
    hitSeverity = severity;
  }

  /** A loose pipe dragged `metres` along the ground. */
  function scrape(metres) {
    wear(metres * SCRAPE_WEAR_PER_M);
  }

  function repair() {
    exhaust.health = 1;
    exhaust.repairRecord = null;
    hitSeverity = 0;
  }

  function getState() {
    return exhaust.health;
  }

  function setState(health) {
    if (breakable && Number.isFinite(health)) exhaust.health = clamp01(health);
  }

  return exhaust;
}
