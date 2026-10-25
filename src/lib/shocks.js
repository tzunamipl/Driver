// Shock absorber wear for wheeledVehicle.js wheels.
//   wheel.shockHealth: 1 new .. 0 blown. Any strike (suspension closing or ground
//   rising under the wheel) harder than HIT_MIN_MS takes health by its speed.
//   A worn shock damps less (the corner floats and keeps bouncing) and its
//   spring sags (that corner sits lower and leans more).

// Strike speed (m/s) a shock shrugs off, and the one that takes all its health in one hit.
export const HIT_MIN_MS = 4.0;
const HIT_FULL_MS = 11;
// Damage grows with this power of the strike over HIT_MIN_MS, so light strikes barely wear.
const HIT_CURVE = 3;
// Share of the stock damping / spring rate left at 0 health.
const DAMPING_FLOOR = 0.25;
const SPRING_FLOOR = 0.7;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Sets a wheel's shock fields from its stock suspension; call once from addWheel. */
export function initShock(wheel) {
  wheel.stockStiffness = wheel.suspensionStiffness;
  wheel.stockDampingCompression = wheel.dampingCompression;
  wheel.stockDampingRelaxation = wheel.dampingRelaxation;
  wheel.shockHitPeak = 0; // hardest severity of the current strike episode
  wheel.shockStrikeMax = 0; // debug HUD: hardest strike speed (m/s) since it last read it
  wheel.shockRepair = null; // lib/partRepair.js record, cleared by a new shock
  setShockHealth(wheel, 1);
}

export function setShockHealth(wheel, health) {
  wheel.shockHealth = clamp01(health);
  const damping = DAMPING_FLOOR + (1 - DAMPING_FLOOR) * wheel.shockHealth;
  const spring = SPRING_FLOOR + (1 - SPRING_FLOOR) * wheel.shockHealth;
  wheel.suspensionStiffness = wheel.stockStiffness * spring;
  wheel.dampingCompression = wheel.stockDampingCompression * damping;
  wheel.dampingRelaxation = wheel.stockDampingRelaxation * damping;
}

/** Strike speed (m/s) of a grounded step; one hit spans several steps, only its hardest moment counts. */
export function strikeShock(wheel, speed) {
  if (speed > wheel.shockStrikeMax) wheel.shockStrikeMax = speed;
  if (speed <= HIT_MIN_MS) {
    endShockStrike(wheel);
    return;
  }
  const severity = clamp01((speed - HIT_MIN_MS) / (HIT_FULL_MS - HIT_MIN_MS)) ** HIT_CURVE;
  if (severity <= wheel.shockHitPeak) return;
  setShockHealth(wheel, wheel.shockHealth - (severity - wheel.shockHitPeak));
  wheel.shockHitPeak = severity;
}

/** Call on steps with no strike (airborne or below HIT_MIN_MS): the next one is a new hit. */
export function endShockStrike(wheel) {
  wheel.shockHitPeak = 0;
}

export function repairShock(wheel) {
  wheel.shockHitPeak = 0;
  wheel.shockRepair = null;
  setShockHealth(wheel, 1);
}
