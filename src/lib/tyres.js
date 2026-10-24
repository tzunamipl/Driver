// Tyre wear + punctures for wheeledVehicle.js wheels.
//   wheel.tread: 1 new .. 0 bald. Sliding wears it most (friction x slip
//     distance, relative to the wheel's static load), rolling a little more
//     the harder the tyre works. Worn tread grips less; bald pops.
//   wheel.punctured: deflated, the wheel runs on its rim: smaller rolling
//     radius (that corner drops), little grip, heavy drag, no sidewall to soak
//     up bumps and a flapping tyre thumping once per revolution.
// Rim strikes pop a tyre: the suspension bottoms out and the tyre is crushed
// against the rim faster than it can take, less the more worn it is.

const GRAVITY = 9.82;
// Metres of slip at a friction force equal to the static load that wear a tyre bald.
const SLIDE_LIFE_M = 1800;
// Metres of rolling that wear a tyre bald: base share + gripFraction^2.
const ROLL_LIFE_M = 100000;
const ROLL_WEAR_BASE = 0.25;
// Grip lost at 0 tread; (1 - tread)^curve, so the first half wears in gently.
const WORN_GRIP_LOSS = 0.3;
const WORN_GRIP_CURVE = 1.5;
// On the rim: share of the tyre's grip left, rolling resistance multiplier.
const RIM_GRIP = 0.45;
const RIM_ROLLING_RESISTANCE = 25;
// Share of the sidewall height the wheel drops when deflated (the rest is squashed rubber).
const RIM_DROP_SHARE = 0.8;
// Toe (rad) a collapsed tyre drags its wheel into, so the car pulls towards the flat.
const RIM_TOE_RAD = 0.02;
// Height (m) of the once-per-revolution thump of a flat tyre flapping under the rim.
const RIM_LUMP_M = 0.012;
// Strike speed (m/s) a new tyre survives; a bald one keeps only MIN_STRENGTH of it.
const STRIKE_SPEED = 8;
const MIN_STRENGTH = 0.45;

/** Sets a wheel's tyre fields; call once from addWheel. */
export function initTyre(wheel) {
  wheel.tread = 1;
  wheel.punctured = false;
  wheel.inflatedRadius = wheel.radius;
  wheel.inflatedSidewall = wheel.sidewallHeight;
  wheel.rimToe = 0; // steering offset (rad) while flat
  wheel.staticLoadN ??= (wheel.body.mass * GRAVITY) / 4;
  wheel.lastStrikeSpeed = 0; // debug HUD: last rim strike (m/s) and what it took to pop
  wheel.lastStrikeLimit = 0;
}

/** Grip multiplier from tread wear, or the rim's when punctured. */
export function tyreGrip(wheel) {
  if (wheel.punctured) return RIM_GRIP;
  return 1 - WORN_GRIP_LOSS * Math.pow(1 - wheel.tread, WORN_GRIP_CURVE);
}

export function tyreRollingResistance(wheel) {
  return wheel.punctured ? RIM_ROLLING_RESISTANCE : 1;
}

/** Strike speed that pops this tyre on this surface. */
export function strikeLimit(wheel, compound) {
  const strength = MIN_STRENGTH + (1 - MIN_STRENGTH) * wheel.tread;
  return (STRIKE_SPEED * strength) / (compound.punctureMultiplier ?? 1);
}

/**
 * Wear for one grounded step. `frictionImpulse` = |patch impulse| (N s),
 * `slipSpeed` = patch slip (m/s), `rollSpeed` = patch speed (m/s).
 * Returns true if the tread just ran out (the tyre pops).
 */
export function wearTyre(wheel, frictionImpulse, slipSpeed, rollSpeed, compound, dt) {
  if (wheel.punctured) return false;
  const loadShare = frictionImpulse / dt / wheel.staticLoadN;
  const grip = wheel.gripFraction ?? 0;
  const wear =
    (loadShare * slipSpeed * dt) / SLIDE_LIFE_M +
    (Math.abs(rollSpeed) * dt * (ROLL_WEAR_BASE + grip * grip)) / ROLL_LIFE_M;
  wheel.tread = Math.max(0, wheel.tread - wear * (compound.tyreWearMultiplier ?? 1));
  return wheel.tread === 0;
}

/** Rim strike check; true if it pops the tyre. */
export function strikeTyre(wheel, strikeSpeed, compound) {
  if (wheel.punctured) return false;
  const limit = strikeLimit(wheel, compound);
  wheel.lastStrikeSpeed = strikeSpeed;
  wheel.lastStrikeLimit = limit;
  return strikeSpeed > limit;
}

export function punctureTyre(wheel) {
  wheel.punctured = true;
  wheel.radius = wheel.inflatedRadius - wheel.inflatedSidewall * RIM_DROP_SHARE;
  wheel.sidewallHeight = 0;
  const { x, z } = wheel.chassisConnectionPointLocal;
  wheel.rimToe = Math.sign(x || 1) * Math.sign(z || 1) * RIM_TOE_RAD; // signs: towards the flat's side, front or rear
}

export function repairTyre(wheel) {
  wheel.tread = 1;
  wheel.punctured = false;
  wheel.radius = wheel.inflatedRadius;
  wheel.sidewallHeight = wheel.inflatedSidewall;
  wheel.rimToe = 0;
  wheel.lastStrikeSpeed = 0;
  wheel.lastStrikeLimit = 0;
}

/** Ray shortening (m) from a flat tyre's thump at this wheel rotation. */
export function rimLump(wheel) {
  if (!wheel.punctured) return 0;
  return RIM_LUMP_M * Math.pow(Math.max(0, Math.sin(wheel.rotation)), 8);
}
