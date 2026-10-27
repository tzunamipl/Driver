// Tyre wear + punctures for wheeledVehicle.js wheels.
//   wheel.tread: 1 new .. 0 bald. Sliding wears it most (friction x slip
//     distance, relative to the wheel's static load), rolling a little more
//     the harder the tyre works. Worn tread grips less; bald pops.
//   wheel.punctured: deflated, the wheel runs on its rim: smaller rolling
//     radius (that corner drops), little grip, heavy drag, no sidewall to soak
//     up bumps and a flapping tyre thumping once per revolution.
//   wheel.tyreShed: after FLAT_SHED_M on the flat the tyre comes off the rim;
//     the wheel runs on the bare rim (rim radius, no flapping).
// Rim strikes pop a tyre: the suspension bottoms out and the tyre is crushed
// against the rim faster than it can take, less the more worn it is.
//   wheel.rimBroken: a much harder strike squashes the rim oval; twice a
//     revolution the hub drops onto its short axis. Hard ground breaks rims sooner
//     (surface rimBreakMultiplier). A new tyre comes on a new wheel, so repairTyre fixes it.
// wheel.compound (tyres/compounds.js) sets grip per surface, wear, rolling drag and
// carcass strength; temperature, dirt and water live in tyres/condition.js.
import { getSurfaceCompound } from './surfaceCompounds.js';
import { compoundGripOn, compoundWearOn, compoundRollingOn } from './tyres/compounds.js';
import { initCondition, freshCondition, warmCondition, temperatureGrip, wetGrip, dirtGrip, overheatWear } from './tyres/condition.js';

export { updateCondition, conditionState, setConditionState } from './tyres/condition.js';

const GRAVITY = 9.82;
// Metres of slip at a friction force equal to the static load that wear a tyre bald.
const SLIDE_LIFE_M = 84000;
// Metres of rolling that wear a tyre bald: base share + gripFraction^2.
const ROLL_LIFE_M = 1000000;
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
// Metres rolled on a flat before the shredded tyre comes off the rim.
const FLAT_SHED_M = 25;
// Strike speed (m/s) a new tyre survives; a bald one keeps only MIN_STRENGTH of it.
const STRIKE_SPEED = 8;
const MIN_STRENGTH = 0.45;
// Strike speed (m/s) a rim survives; less on its rim (no tyre to cushion it).
const RIM_BREAK_SPEED = 15;
const RIM_BREAK_FLAT_SHARE = 0.6;
// Broken rim: how much (m) shorter its oval's short semi-axis is than the round radius.
const RIM_OVAL_DROP_M = 0.07;

/** Sets a wheel's tyre fields; call once from addWheel. */
export function initTyre(wheel) {
  wheel.tread = 1;
  wheel.punctured = false;
  wheel.tyreShed = false;
  wheel.flatRolledM = 0;
  wheel.rimBroken = false;
  wheel.rimFlatAngle = 0; // wheel rotation (rad) at which the oval's short axis points down
  wheel.rimDrop = 0; // hub drop (m) onto the oval this step
  wheel.inflatedRadius = wheel.radius;
  wheel.inflatedSidewall = wheel.sidewallHeight;
  wheel.rimToe = 0; // steering offset (rad) while flat
  wheel.staticLoadN ??= (wheel.body.mass * GRAVITY) / 4;
  wheel.lastStrikeSpeed = 0; // debug HUD: last rim strike (m/s) and what it took to pop
  wheel.lastStrikeLimit = 0;
  wheel.strikeScale ??= 1; // sidewall height vs stock (tyres/setup.js): taller survives harder hits
  initCondition(wheel);
}

/** Grip multiplier on the wheel's surface: compound, tread, temperature, water and dirt; the rim's when punctured. */
export function tyreGrip(wheel) {
  if (wheel.punctured) return RIM_GRIP;
  return treadGrip(wheel) * gripBreakdown(wheel).total;
}

/** Tread wear's share of grip. */
export const treadGrip = (wheel) => 1 - WORN_GRIP_LOSS * Math.pow(1 - wheel.tread, WORN_GRIP_CURVE);

/** Condition factors of tyreGrip (tread aside), for the debug HUD. */
export function gripBreakdown(wheel) {
  const surface = getSurfaceCompound(wheel.surface);
  const compound = compoundGripOn(wheel.compound, wheel.surface);
  const temp = temperatureGrip(wheel);
  const wet = wetGrip(wheel, surface);
  const dirt = dirtGrip(wheel, surface);
  return { compound, temp, wet, dirt, total: compound * temp * wet * dirt };
}

export function tyreRollingResistance(wheel) {
  return wheel.punctured ? RIM_ROLLING_RESISTANCE : compoundRollingOn(wheel.compound, wheel.surface);
}

/** Strike speed that pops this tyre on this surface. */
export function strikeLimit(wheel, compound) {
  const strength = (MIN_STRENGTH + (1 - MIN_STRENGTH) * wheel.tread) * (wheel.compound.puncture ?? 1) * wheel.strikeScale;
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
  const tyreWear = compoundWearOn(wheel.compound, wheel.surface) * overheatWear(wheel);
  wheel.tread = Math.max(0, wheel.tread - wear * tyreWear * (compound.tyreWearMultiplier ?? 1));
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

/** Rim strike check; true if it breaks the rim. */
export function strikeRim(wheel, strikeSpeed, compound) {
  if (wheel.rimBroken) return false;
  const limit = (RIM_BREAK_SPEED * wheel.strikeScale * (wheel.punctured ? RIM_BREAK_FLAT_SHARE : 1)) / (compound.rimBreakMultiplier ?? 1);
  return strikeSpeed > limit;
}

/** Squashes the rim oval along the direction that was down when it struck. */
export function breakRim(wheel) {
  wheel.rimBroken = true;
  wheel.rimFlatAngle = wheel.rotation;
}

export function punctureTyre(wheel) {
  wheel.punctured = true;
  wheel.flatRolledM = 0;
  wheel.radius = wheel.inflatedRadius - wheel.inflatedSidewall * RIM_DROP_SHARE;
  wheel.sidewallHeight = 0;
  const { x, z } = wheel.chassisConnectionPointLocal;
  wheel.rimToe = Math.sign(x || 1) * Math.sign(z || 1) * RIM_TOE_RAD; // signs: towards the flat's side, front or rear
}

/** Rolls a flat `metres` further; true when that sheds the tyre. */
export function rollFlat(wheel, metres) {
  if (!wheel.punctured || wheel.tyreShed) return false;
  wheel.flatRolledM += metres;
  if (wheel.flatRolledM < FLAT_SHED_M) return false;
  shedTyre(wheel);
  return true;
}

/** The tyre is gone: the wheel runs on its bare rim. */
export function shedTyre(wheel) {
  if (!wheel.punctured) punctureTyre(wheel);
  wheel.tyreShed = true;
  wheel.radius = wheel.inflatedRadius - wheel.inflatedSidewall;
}

/** Back on its tyre, tread unchanged. */
export function inflateTyre(wheel) {
  wheel.punctured = false;
  wheel.tyreShed = false;
  wheel.flatRolledM = 0;
  wheel.radius = wheel.inflatedRadius;
  wheel.sidewallHeight = wheel.inflatedSidewall;
  wheel.rimToe = 0;
}

/** Fresh tyre of the same compound on a new rim: full tread, clean, at outside temperature. */
export function repairTyre(wheel) {
  inflateTyre(wheel);
  wheel.rimBroken = false;
  freshCondition(wheel);
  wheel.tread = 1;
  wheel.lastStrikeSpeed = 0;
  wheel.lastStrikeLimit = 0;
}

/** Fresh tyre warmed close to its working temperature, for an event start. */
export function freshWarmTyre(wheel) {
  repairTyre(wheel);
  warmCondition(wheel);
}

/** Ray shortening (m) from a flat tyre's thump at this wheel rotation. */
export function rimLump(wheel) {
  if (!wheel.punctured || wheel.tyreShed) return 0;
  return RIM_LUMP_M * Math.pow(Math.max(0, Math.sin(wheel.rotation)), 8);
}

/** Hub drop (m) onto a broken rim's oval at this wheel rotation: radius less the ellipse's height over the ground. */
export function rimFlatDrop(wheel) {
  if (!wheel.rimBroken) return 0;
  const a = wheel.radius;
  const b = a - RIM_OVAL_DROP_M;
  const c = Math.cos(wheel.rotation - wheel.rimFlatAngle);
  return a - Math.sqrt(b * b * c * c + a * a * (1 - c * c));
}

/** Broken rim's oval for the wheel mesh: { angle } of its short axis (wheel rotation), { squash } = short / round radius. */
export function rimOval(wheel) {
  return wheel.rimBroken ? { angle: wheel.rimFlatAngle, squash: 1 - RIM_OVAL_DROP_M / wheel.radius } : { angle: 0, squash: 1 };
}
