// Tyre condition beyond tread (tyres.js): tread temperature, dirt and water, per wheel.
//   wheel.tempC: heated by rolling hysteresis, the slip of a working patch and sliding,
//     cooled by air (more with speed) and water. Grip peaks within the compound's
//     optimal window; overheating wears the tread faster.
//   wheel.dirt 0 clean .. 1 caked: rolling on a surface drifts it towards that
//     surface's dirtLevel (higher when wet: mud); tyres fling it off faster with speed.
//   wheel.wetness 0 dry .. 1 soaked: soaked in water, dries as it rolls; never
//     below the weather's wetness.
import { getAirTempC, getWetness } from '../weather.js';
import { getTyreCompound } from './compounds.js';
import { getSurfaceCompound } from '../surfaceCompounds.js';

// Tread heat capacity per m^2 of tread band (2 pi r x width): ~3.6 kJ/K for a 225/40 R18.
const TREAD_HEAT_J_PER_K_M2 = 8000;
// Air cooling per m^2 of tread band (W/K): still air + per m/s of speed.
const COOL_STILL_W_PER_K_M2 = 10;
const COOL_PER_MS_W_PER_K_M2 = 2.3;
// Cooling multiplier on a fully wet tyre (evaporation), and in water.
const WET_COOLING = 3;
const WATER_COOLING = 12;
// Rolling hysteresis heat: this Crr-like share of load x roll speed goes into the tread.
const ROLL_HEAT_CRR = 0.015;
// A gripping patch still creeps: this share of the friction force x roll speed heats it.
const GRIP_CREEP_SHARE = 0.04;
// Share of sliding friction power that goes into the tyre (the rest heats the ground).
const SLIDE_HEAT_SHARE = 0.5;
// Degrees outside the optimal window over which the compound's tempGripLoss fully applies.
const TEMP_FALLOFF_C = 60;
// Heat input share once the tread is above the optimal window: overheating builds slowly.
const OVERHEAT_HEAT_SHARE = 0.25;
// Extra wear per degree above the window.
const OVERHEAT_WEAR_PER_C = 0.04;
// Dirt drift per metre rolled: picking up, shedding (x (1 + speed / DIRT_FLING_SPEED)).
const DIRT_PICKUP_PER_M = 1 / 60;
const DIRT_SHED_PER_M = 1 / 500;
const DIRT_FLING_SPEED = 20;
// Water washes dirt off per metre (or per second standing in it).
const WASH_PER_M = 1 / 8;
// Wet surfaces cake up to this much more (mud).
const MUD_DIRT_GAIN = 1;
// Wetness: soaking per second in water, drying per metre rolled and per second.
const SOAK_PER_S = 2;
const DRY_PER_M = 1 / 400;
const DRY_PER_S = 1 / 120;
// Warmed-up tyres (event start) sit this share of the window below the optimum.
const WARM_WINDOW_SHARE = 0.5;

/** Sets a wheel's condition fields (fresh, at outside temperature); call from initTyre. */
export function initCondition(wheel) {
  wheel.compound ??= getTyreCompound(null);
  const band = 2 * Math.PI * (wheel.inflatedRadius ?? wheel.radius) * (wheel.width ?? 0.225);
  wheel.treadHeatCapacity = TREAD_HEAT_J_PER_K_M2 * band;
  wheel.treadBandM2 = band;
  freshCondition(wheel);
}

/** New, clean, dry tyre at outside temperature (the weather's wetness). */
export function freshCondition(wheel) {
  wheel.tempC = getAirTempC();
  wheel.dirt = 0;
  wheel.wetness = getWetness();
}

/** Tread warmed to just under the compound's optimum (tyre blankets before a start). */
export function warmCondition(wheel) {
  const c = wheel.compound;
  wheel.tempC = Math.max(wheel.tempC, c.optimalTempC - c.windowC * WARM_WINDOW_SHARE);
}

/** Temperature grip multiplier: 1 in the window, down to 1 - tempGripLoss TEMP_FALLOFF_C beyond it. */
export function temperatureGrip(wheel) {
  const c = wheel.compound;
  const off = Math.max(0, Math.abs(wheel.tempC - c.optimalTempC) - c.windowC);
  return 1 - c.tempGripLoss * Math.min(1, off / TEMP_FALLOFF_C);
}

/** Wet grip multiplier on this surface: the compound's wet grip (by tread) where water matters. */
export function wetGrip(wheel, surface) {
  const c = wheel.compound;
  const kept = c.wetGripBald + (c.wetGrip - c.wetGripBald) * wheel.tread;
  return 1 - wheel.wetness * (surface.wetSensitivity ?? 1) * (1 - kept);
}

export function dirtGrip(wheel, surface) {
  return 1 - wheel.dirt * (surface.dirtSensitivity ?? 1) * (wheel.compound.dirtGripLoss ?? 0);
}

/** Wear multiplier from running hot. */
export function overheatWear(wheel) {
  const c = wheel.compound;
  return 1 + Math.max(0, wheel.tempC - c.optimalTempC - c.windowC) * OVERHEAT_WEAR_PER_C;
}

/**
 * One physics step. `frictionForceN` = |patch friction force|, `slipSpeed` = patch slip (m/s),
 * `rollSpeed` = patch speed (m/s); all 0 in the air. `surfaceKey` = the ground's surface, or null in the air.
 */
export function updateCondition(wheel, surfaceKey, frictionForceN, slipSpeed, rollSpeed, dt) {
  const c = wheel.compound;
  const speed = Math.abs(rollSpeed);
  const surface = surfaceKey ? getSurfaceCompound(surfaceKey) : null;
  const inWater = surfaceKey === 'water';

  // Temperature.
  const overheated = wheel.tempC > c.optimalTempC + c.windowC;
  const heatW = surface
    ? (wheel.suspensionForce * speed * ROLL_HEAT_CRR + frictionForceN * speed * GRIP_CREEP_SHARE + frictionForceN * slipSpeed * SLIDE_HEAT_SHARE) * (c.heatRate ?? 1) * (overheated ? OVERHEAT_HEAT_SHARE : 1)
    : 0;
  const airSpeed = surface ? speed : Math.abs(wheel.spinSpeed);
  const cooling = (COOL_STILL_W_PER_K_M2 + COOL_PER_MS_W_PER_K_M2 * airSpeed) * wheel.treadBandM2 * (inWater ? WATER_COOLING : 1 + (WET_COOLING - 1) * wheel.wetness);
  const capacity = wheel.treadHeatCapacity;
  // Implicit in the cooling term, so big steps / strong cooling never overshoot ambient.
  wheel.tempC = (wheel.tempC * capacity + (heatW + cooling * getAirTempC()) * dt) / (capacity + cooling * dt);

  // Water.
  const rolledM = speed * dt;
  if (inWater) wheel.wetness = Math.min(1, wheel.wetness + SOAK_PER_S * dt);
  else wheel.wetness = Math.max(getWetness(), wheel.wetness - rolledM * DRY_PER_M - dt * DRY_PER_S);

  // Dirt.
  if (!surface) return;
  if (inWater) {
    wheel.dirt = Math.max(0, wheel.dirt - Math.max(rolledM, dt) * WASH_PER_M);
    return;
  }
  const target = Math.min(1, (surface.dirtLevel ?? 0) * (1 + MUD_DIRT_GAIN * wheel.wetness));
  if (wheel.dirt < target) {
    wheel.dirt = Math.min(target, wheel.dirt + rolledM * DIRT_PICKUP_PER_M * (c.dirtPickup ?? 1));
  } else {
    wheel.dirt = Math.max(target, wheel.dirt - rolledM * DIRT_SHED_PER_M * (c.dirtShed ?? 1) * (1 + speed / DIRT_FLING_SPEED));
  }
}

/** Saved condition fields. */
export const conditionState = (wheel) => ({ tempC: wheel.tempC, dirt: wheel.dirt, wetness: wheel.wetness });

/** Restores saved condition; `parkedS` cools the tread back towards outside temperature. */
export function setConditionState(wheel, s, parkedS = 0) {
  const num = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
  const tempC = num(s?.tempC, -50, 300);
  if (tempC !== null) {
    const still = COOL_STILL_W_PER_K_M2 * wheel.treadBandM2;
    wheel.tempC = getAirTempC() + (tempC - getAirTempC()) * Math.exp((-still * Math.max(0, parkedS)) / wheel.treadHeatCapacity);
  }
  wheel.dirt = num(s?.dirt, 0, 1) ?? wheel.dirt;
  wheel.wetness = Math.max(getWetness(), num(s?.wetness, 0, 1) ?? wheel.wetness);
}
