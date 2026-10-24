// Shock absorber wear for wheeledVehicle.js wheels.
//   wheel.shockHealth: 1 new .. 0 blown. Bottoming out (the suspension hitting
//   its bump stop zone) harder than HIT_MIN_MS takes health by the strike speed.
//   A worn shock damps less (the corner floats and keeps bouncing) and its
//   spring sags (that corner sits lower and leans more).

// Strike speed (m/s) a shock shrugs off, and the one that takes all its health in one hit.
export const HIT_MIN_MS = 0.8;
const HIT_FULL_MS = 11;
// Share of the stock damping / spring rate left at 0 health.
const DAMPING_FLOOR = 0.25;
const SPRING_FLOOR = 0.7;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Sets a wheel's shock fields from its stock suspension; call once from addWheel. */
export function initShock(wheel) {
  wheel.stockStiffness = wheel.suspensionStiffness;
  wheel.stockDampingCompression = wheel.dampingCompression;
  wheel.stockDampingRelaxation = wheel.dampingRelaxation;
  wheel.shockHitPeak = 0; // hardest severity of the current bump-stop episode
  wheel.shockStrikeMax = 0; // debug HUD: hardest strike speed (m/s), bump stop or not, since it last read it
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

/** Strike speed of any grounded step, for the debug HUD; only bump-stop strikes (strikeShock) do damage. */
export function noteShockLoad(wheel, speed) {
  if (speed > wheel.shockStrikeMax) wheel.shockStrikeMax = speed;
}

/** Bump-stop strike at `speed` m/s; one bottoming spans several steps, only its hardest moment counts. */
export function strikeShock(wheel, speed) {
  const severity = clamp01((speed - HIT_MIN_MS) / (HIT_FULL_MS - HIT_MIN_MS));
  if (severity <= wheel.shockHitPeak) return;
  setShockHealth(wheel, wheel.shockHealth - (severity - wheel.shockHitPeak));
  wheel.shockHitPeak = severity;
}

/** Call on steps clear of the bump stop: the next bottoming is a new hit. */
export function endShockStrike(wheel) {
  wheel.shockHitPeak = 0;
}

export function repairShock(wheel) {
  wheel.shockHitPeak = 0;
  setShockHealth(wheel, 1);
}
