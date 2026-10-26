// Tyre setup a player fits to a wheeled vehicle: { compound, rimSize, width, profile } for the
// descriptor's main tyre, plus the look of its rims: `rim` (car/rims.js id, or AUTO_RIM = the car's
// rim for the compound) and `rimColor` (0xRRGGBB, null = the rim's / car's own). Axles (and trailers) with their own `wheel` keep their stock ratio
// to it: same rim change, width and profile scaled alike. Size ranges sit around the stock
// size; a descriptor can set its own `tyreSizes: { rim: [min, max], width: [...], profile: [...] }`
// and its stock compound as `tyreCompound`.
import { DEFAULT_TYRE_COMPOUND, TYRE_COMPOUNDS } from './compounds.js';
import { AUTO_RIM, RIMS } from '../car/rims.js';

const DEFAULT_RIM_IN = 15;
const DEFAULT_WIDTH_MM = 225;
const DEFAULT_PROFILE = 45;
// Range around stock: +-2" rims in 1" steps, +-30 mm widths in 10 mm, +-20 profile in 5.
const RIM_SPAN_IN = 2;
const RIM_STEP_IN = 1;
const WIDTH_SPAN_MM = 30;
const WIDTH_STEP_MM = 10;
const PROFILE_SPAN = 20;
const PROFILE_STEP = 5;
const MIN_RIM_IN = 10;
const MIN_WIDTH_MM = 105;
const MIN_PROFILE = 10;
const MAX_PROFILE = 95;

/** The vehicle's own tyres. */
export function stockTyreSetup(descriptor) {
  return {
    compound: descriptor.tyreCompound ?? DEFAULT_TYRE_COMPOUND,
    rimSize: descriptor.rimSize ?? DEFAULT_RIM_IN,
    width: descriptor.tyre ?? DEFAULT_WIDTH_MM,
    profile: descriptor.profile ?? DEFAULT_PROFILE,
    rim: AUTO_RIM,
    rimColor: null,
  };
}

function steps(stock, span, step, min, max = Infinity) {
  const list = [];
  for (let v = stock - span; v <= stock + span + 1e-6; v += step) if (v >= min && v <= max) list.push(Math.round(v * 10) / 10);
  return list;
}

function between([lo, hi], stock, step) {
  const list = [];
  for (let v = lo; v <= hi + 1e-6; v += step) list.push(Math.round(v * 10) / 10);
  return list.includes(stock) ? list : [...list, stock].sort((a, b) => a - b);
}

/** Selectable { rim, width, profile } value lists for this vehicle. */
export function tyreSizeOptions(descriptor) {
  const stock = stockTyreSetup(descriptor);
  const own = descriptor.tyreSizes ?? {};
  return {
    rim: own.rim ? between(own.rim, stock.rimSize, RIM_STEP_IN) : steps(stock.rimSize, RIM_SPAN_IN, RIM_STEP_IN, MIN_RIM_IN),
    width: own.width ? between(own.width, stock.width, WIDTH_STEP_MM) : steps(stock.width, WIDTH_SPAN_MM, WIDTH_STEP_MM, MIN_WIDTH_MM),
    profile: own.profile
      ? between(own.profile, stock.profile, PROFILE_STEP)
      : steps(stock.profile, PROFILE_SPAN, PROFILE_STEP, MIN_PROFILE, MAX_PROFILE),
  };
}

const closest = (list, v) => list.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), list[0]);

/** A saved / picked setup made valid for this vehicle (unknown fields -> stock, sizes snapped to its options). */
export function sanitizeTyreSetup(descriptor, setup) {
  const stock = stockTyreSetup(descriptor);
  if (!setup || typeof setup !== 'object') return stock;
  const options = tyreSizeOptions(descriptor);
  const pick = (list, v, fallback) => (Number.isFinite(v) ? closest(list, v) : fallback);
  return {
    compound: TYRE_COMPOUNDS[setup.compound] ? setup.compound : stock.compound,
    rimSize: pick(options.rim, setup.rimSize, stock.rimSize),
    width: pick(options.width, setup.width, stock.width),
    profile: pick(options.profile, setup.profile, stock.profile),
    rim: RIMS[setup.rim] ? setup.rim : AUTO_RIM,
    rimColor: Number.isInteger(setup.rimColor) && setup.rimColor >= 0 && setup.rimColor <= 0xffffff ? setup.rimColor : null,
  };
}

/** Same tyres (compound + sizes); the rim look doesn't count, see sameRims. */
export const sameTyreSetup = (a, b) => !!a && !!b && a.compound === b.compound && a.rimSize === b.rimSize && a.width === b.width && a.profile === b.profile;

/** Same rim style + colour (missing fields = stock). */
export const sameRims = (a, b) => !!a && !!b && (a.rim ?? AUTO_RIM) === (b.rim ?? AUTO_RIM) && (a.rimColor ?? null) === (b.rimColor ?? null);

/** '225/40 R18' */
export const tyreSizeLabel = ({ width, profile, rimSize }) => `${width}/${profile} R${rimSize}`;

/** One tyre spec ({ rimSize, tyre, profile }) changed by the setup's difference from stock. */
function resize(spec, stock, setup) {
  const rimSize = (spec.rimSize ?? stock.rimSize) + setup.rimSize - stock.rimSize;
  const tyre = Math.round(((spec.tyre ?? stock.width) * setup.width) / stock.width);
  const profile = Math.round(((spec.profile ?? stock.profile) * setup.profile) / stock.profile);
  return { rimSize, tyre, profile };
}

/**
 * The descriptor with the setup's sizes on every tractor axle and its compound everywhere
 * (`tyreCompound`, read by car.js). A trailer keeps its own sizes. Stock setup -> unchanged sizes.
 */
export function applyTyreSetup(descriptor, setup) {
  if (descriptor.vehicleType === 'hover') return descriptor;
  const stock = stockTyreSetup(descriptor);
  const s = sanitizeTyreSetup(descriptor, setup);
  // Sized by `wheelRadius` alone: only the compound applies.
  if (!(descriptor.rimSize && descriptor.tyre && descriptor.profile)) return { ...descriptor, tyreCompound: s.compound, tyreSetup: s };
  const main = resize(descriptor, stock, s);
  const axles = descriptor.axles?.map((a) => (a.wheel ? { ...a, wheel: { ...a.wheel, ...resize(a.wheel, stock, s) } } : a));
  // The trailer would otherwise inherit the resized tractor tyre (car.js trailerSpecOf).
  const trailer = descriptor.trailer && { rimSize: stock.rimSize, tyre: stock.width, profile: stock.profile, ...descriptor.trailer };
  // A taller sidewall than stock takes harder rim strikes (tyres.js).
  const tyreStrikeScale = Math.sqrt((s.width * s.profile) / (stock.width * stock.profile));
  return { ...descriptor, ...main, ...(axles ? { axles } : {}), ...(trailer ? { trailer } : {}), tyreCompound: s.compound, tyreStrikeScale, tyreSetup: s };
}
