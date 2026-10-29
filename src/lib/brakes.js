// Brakes: a disc (or drum) per wheel, a master cylinder (pump + fluid reservoir) and two pipe
// circuits, front and rear axles (trailer wheels ride on the rear one).
//   Heat: the work the brake does on the wheel (wheeledVehicle.js wheel.brakeWorkJ) heats the
//   rotor; air cools it by road speed (vented discs more, drums much less), radiation once hot,
//   water fast. Pads fade past their working range; past the damage temperature the rotor warps.
//   A hot disc cooled fast (wading in) cracks a little; drums are shielded from that.
//   A worn rotor brakes weaker and pulses (judder) once a revolution.
//   Underbody hits have a small chance to crack the pipe of the circuit under the hit (a skid
//   plate halves it); it leaks, more under pedal pressure. The leaking circuit goes soft first
//   as the reservoir drops, the other one only near empty. The handbrake is a cable: no fluid.
// Descriptor `brakes: { front, rear, pads: 'road' | 'race', fluidL }`, each axle
// `{ discMm, vented }` or `{ drumMm }`.

import { readRepairRecord } from './partRepair.js';

const STEEL_KG_M3 = 7200;
const IRON_J_PER_KG_K = 480;
// Vented discs: share of a solid one's mass, cooling area multiplier.
const VENTED_MASS = 0.62;
const VENTED_AREA = 1.7;
// Disc thickness (m): solid, vented, vented on discs over TRUCK_DISC_M.
const SOLID_THICKNESS_M = 0.012;
const VENTED_THICKNESS_M = 0.026;
const TRUCK_THICKNESS_M = 0.045;
const TRUCK_DISC_M = 0.4;
const HUB_SHARE = 0.35; // inner radius of the friction ring, share of the disc radius
// Drum: shell width and wall thickness as shares of the diameter, back plate (m); the enclosed
// shell sheds this share of what an open disc of that area would.
const DRUM_WIDTH_SHARE = 0.22;
const DRUM_WALL_SHARE = 0.07;
const DRUM_BACK_M = 0.005;
const DRUM_COOLING = 0.6;
// Convection W/m2K: still air + per m/s of road speed; radiation emissivity.
const H_STILL = 12;
const H_PER_MS = 3.5;
const EMISSIVITY = 0.55;
const STEFAN_BOLTZMANN = 5.67e-8;
// Under water (W/m2K, boiling against a hot rotor), and the spray off a wet tyre (cooling multiplier at wetness 1).
const H_WATER = 4000;
// Share of the rotor a wheel in shallow water splashes over (wheel.surface 'water').
const SPLASH_SHARE = 0.1;
const WET_COOLING = 1.3;
// Pad fade starts at (°C) by pads / drum shoes; friction falls to FADE_FLOOR over FADE_SPAN_C.
const FADE_C = { road: 400, race: 600, drum: 280 };
const FADE_SPAN_C = 300;
const FADE_FLOOR = 0.5;
// Rotor warps above fade + this (°C); health lost per s per 100 K above.
const DAMAGE_OVER_FADE_C = 280;
const OVERHEAT_WEAR_PER_S = 1 / 3600;
// Thermal shock: cooling faster than SHOCK_SAFE_KPS while above SHOCK_MIN_C cracks the disc,
// SHOCK_WEAR health per s at SHOCK_FULL_KPS and over (squared ramp).
const SHOCK_MIN_C = 250;
const SHOCK_SAFE_KPS = 40;
const SHOCK_FULL_KPS = 300;
const SHOCK_WEAR_PER_S = 0.15;
// A worn-out rotor (health 0) keeps this much brake, and pulses by this share at worst.
const WORN_FRICTION = 0.6;
const JUDDER = 0.35;
// Fluid: default system volume (L) + per tonne, capped; the full leak empties it in FULL_LEAK_S
// at full pedal pressure; idle pressure leaks this share.
const FLUID_BASE_L = 0.5;
const FLUID_L_PER_T = 0.25;
const FLUID_MAX_L = 2;
const FULL_LEAK_S = 150;
const IDLE_PRESSURE = 0.15;
// Level fractions over which a circuit goes from full pressure to none: the leaking one, a sound one.
const LEAKING_SOFT = [0.15, 0.5];
const SOUND_SOFT = [0, 0.25];
// A cracked pipe also bleeds pressure: this share at the worst leak.
const CRACK_PRESSURE_LOSS = 0.3;
// Pipe cracks: underbody impact speed (m/s) from which a hit may crack one, the one at full chance;
// the chance at full, the leak a crack opens (share of the max), a skid plate's chance multiplier.
const PIPE_MIN_HIT_MS = 4;
const PIPE_FULL_HIT_MS = 16;
const PIPE_CRACK_CHANCE = 0.1;
const PIPE_CRACK_LEAK = [0.2, 0.6];
const SKID_PLATE_CHANCE = 0.5;
const HIT_WINDOW_S = 0.5;
const DEBUG_LEAK = 0.35;
// Warning lamp below this fluid level or a rotor this far into its fade.
const LOW_FLUID = 0.6;
const HOT_LAMP_FADE = 0.9;
// Steam off a wading hot rotor: from this temperature, full at the second.
const STEAM_FROM_C = 100;
const STEAM_FULL_C = 450;
const PARKED_COOL_TAU_S = 20 * 60;
const MAX_STEP_S = 0.05;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const KELVIN = 273.15;

/** Physical rotor from an axle spec ({ discMm, vented } | { drumMm }) and pads. */
export function brakeUnit(axle, pads = 'road') {
  if (axle?.drumMm) {
    const d = axle.drumMm / 1000;
    const width = d * DRUM_WIDTH_SHARE;
    const outsideM2 = Math.PI * d * width + Math.PI * (d / 2) ** 2;
    const massKg = STEEL_KG_M3 * (Math.PI * d * width * d * DRUM_WALL_SHARE + Math.PI * (d / 2) ** 2 * DRUM_BACK_M);
    return { type: 'drum', diameterM: d, width, massKg, areaM2: outsideM2 * DRUM_COOLING, radiatingM2: outsideM2, fadeC: FADE_C.drum };
  }
  const d = (axle?.discMm ?? 280) / 1000;
  const vented = !!axle?.vented;
  const thickness = vented ? (d > TRUCK_DISC_M ? TRUCK_THICKNESS_M : VENTED_THICKNESS_M) : SOLID_THICKNESS_M;
  const ring = Math.PI * (d / 2) ** 2 * (1 - HUB_SHARE ** 2);
  const massKg = STEEL_KG_M3 * ring * thickness * (vented ? VENTED_MASS : 1);
  return { type: 'disc', diameterM: d, thickness, vented, race: pads === 'race', massKg, areaM2: 2 * ring * (vented ? VENTED_AREA : 1), radiatingM2: 2 * ring, fadeC: FADE_C[pads] ?? FADE_C.road };
}

/**
 * @param {object[]} wheels - per wheelInfos index: { unit: brakeUnit(), circuit: 'front' | 'rear' }
 * @param {object} descriptor - vehicle descriptor (brakes.fluidL, mass)
 * @param {number} ambientC
 */
export function createBrakes(wheels, descriptor, ambientC) {
  const capacityL = descriptor.brakes?.fluidL ?? Math.min(FLUID_MAX_L, FLUID_BASE_L + FLUID_L_PER_T * ((descriptor.mass ?? 1500) / 1000));
  const maxLeakLps = capacityL / FULL_LEAK_S;
  let clock = 0;
  const pipeHits = { until: -Infinity, severity: 0 };

  const discs = wheels.map(({ unit, circuit }) => ({
    ...unit,
    circuit,
    heatCapJK: unit.massKg * IRON_J_PER_KG_K,
    damageC: unit.fadeC + DAMAGE_OVER_FADE_C,
    tempC: ambientC,
    health: 1,
    repair: null, // lib/partRepair.js record, cleared by a new rotor
    coolKps: 0, // last update's cooling rate, for the debug HUD
    steam: 0, // 0..1 steam off a hot rotor in water (brakeSteam.js)
  }));
  const circuits = {
    front: { leakLps: 0, repair: null },
    rear: { leakLps: 0, repair: null },
  };
  for (const key of Object.keys(circuits)) {
    const c = circuits[key];
    Object.defineProperty(c, 'health', {
      get: () => 1 - c.leakLps / maxLeakLps,
      set: (h) => (c.leakLps = (1 - clamp01(h)) * maxLeakLps),
    });
  }

  const brakes = {
    discs,
    circuits,
    capacityL,
    fluidL: capacityL,
    lossLps: 0, // last update, for the debug HUD
    pedal: false, // set by car.js applyBrakes: the circuits are pressurised
    noDamage: false, // editor: no wear, no leaks
    get level() {
      return brakes.fluidL / capacityL;
    },
    get warning() {
      return brakes.level < LOW_FLUID || discs.some((d) => fade(d) < HOT_LAMP_FADE);
    },
    pedalFactor,
    frictionFactor,
    pressureFactor,
    fade,
    update,
    hitPipes,
    startLeak,
    repairDisc,
    repairPipe,
    repair,
    getState,
    setState,
  };

  /** Pad friction 1 .. FADE_FLOOR of rotor i's temperature. */
  function fade(d) {
    return 1 - (1 - FADE_FLOOR) * clamp01((d.tempC - d.fadeC) / FADE_SPAN_C);
  }

  /** Friction of wheel i's rotor (fade, wear, judder at wheel `rotation` rad); the handbrake gets this. */
  function frictionFactor(i, rotation = 0) {
    const d = discs[i];
    if (!d) return 1;
    const worn = 1 - d.health;
    const judder = 1 - JUDDER * worn * (0.5 + 0.5 * Math.sin(rotation));
    return fade(d) * (WORN_FRICTION + (1 - WORN_FRICTION) * d.health) * judder;
  }

  /** Line pressure share of a circuit: fluid level and its pipe. */
  function pressureFactor(circuit) {
    const c = circuits[circuit];
    if (!c) return 1;
    const leaking = c.leakLps > 0;
    const [lo, hi] = leaking ? LEAKING_SOFT : SOUND_SOFT;
    const air = clamp01((brakes.level - lo) / (hi - lo));
    return air * (1 - CRACK_PRESSURE_LOSS * (c.leakLps / maxLeakLps));
  }

  /** Pedal brake multiplier of wheel i. */
  function pedalFactor(i, rotation) {
    return frictionFactor(i, rotation) * pressureFactor(discs[i]?.circuit);
  }

  /**
   * Per frame: takes each wheel's brake work, cools the rotors.
   * `wheels`: wheelInfos (brakeWorkJ, spinSpeed, wetness, radius); `sinks`: water depth per wheel (m).
   */
  function update(dt, wheels, speedMs, ambient, sinks) {
    if (dt <= 0) return;
    clock += dt;
    const air = H_STILL + H_PER_MS * Math.abs(speedMs);
    const ambientK = ambient + KELVIN;
    const waterC = Math.max(4, ambient);
    discs.forEach((d, i) => {
      const wheel = wheels[i];
      const workJ = wheel?.brakeWorkJ ?? 0;
      if (wheel) wheel.brakeWorkJ = 0;
      // Share of the rotor under water: it spans the wheel centre +- its radius.
      const r = d.diameterM / 2;
      const depth = sinks?.[i] ?? 0;
      const submerged = wheel ? Math.max(wheel.surface === 'water' ? SPLASH_SHARE : 0, clamp01((depth - (wheel.radius - r)) / (2 * r))) : 0;
      const wet = 1 + (WET_COOLING - 1) * (wheel?.wetness ?? 0);
      const before = d.tempC;
      const steps = Math.ceil(dt / MAX_STEP_S);
      const h = dt / steps;
      for (let s = 0; s < steps; s++) {
        const t = d.tempC + KELVIN;
        const radiation = EMISSIVITY * STEFAN_BOLTZMANN * d.radiatingM2 * (t * t + ambientK * ambientK) * (t + ambientK);
        const toAir = air * d.areaM2 * wet + radiation;
        const toWater = H_WATER * d.areaM2 * submerged;
        // Implicit, so a quench never overshoots the water's temperature.
        d.tempC = (d.tempC * d.heatCapJK + (workJ / steps) + (toAir * ambient + toWater * waterC) * h) / (d.heatCapJK + (toAir + toWater) * h);
      }
      const heatedK = workJ / d.heatCapJK;
      d.coolKps = Math.max(0, (before + heatedK - d.tempC) / dt);
      d.steam = submerged > 0 ? clamp01((d.tempC - STEAM_FROM_C) / (STEAM_FULL_C - STEAM_FROM_C)) * Math.min(1, submerged * 3) : 0;
      if (brakes.noDamage) return;
      let wear = OVERHEAT_WEAR_PER_S * Math.max(0, d.tempC - d.damageC) / 100;
      if (d.type === 'disc' && before > SHOCK_MIN_C) wear += SHOCK_WEAR_PER_S * clamp01((d.coolKps - SHOCK_SAFE_KPS) / (SHOCK_FULL_KPS - SHOCK_SAFE_KPS)) ** 2;
      d.health = clamp01(d.health - wear * dt);
    });
    const pressure = brakes.pedal ? 1 : IDLE_PRESSURE;
    const leak = brakes.noDamage || brakes.fluidL <= 0 ? 0 : (circuits.front.leakLps + circuits.rear.leakLps) * pressure;
    brakes.lossLps = leak;
    brakes.fluidL = Math.max(0, brakes.fluidL - leak * dt);
  }

  /** Underbody impact at `speedMs`, chassis-local z `localZ`: a small chance to crack that end's pipe. */
  function hitPipes(speedMs, localZ, shielded = false) {
    if (brakes.noDamage) return;
    const severity = clamp01((speedMs - PIPE_MIN_HIT_MS) / (PIPE_FULL_HIT_MS - PIPE_MIN_HIT_MS));
    if (severity <= 0) return;
    if (clock > pipeHits.until) pipeHits.severity = 0;
    pipeHits.until = clock + HIT_WINDOW_S;
    if (severity <= pipeHits.severity) return;
    const extra = severity - pipeHits.severity;
    pipeHits.severity = severity;
    if (Math.random() >= PIPE_CRACK_CHANCE * extra * (shielded ? SKID_PLATE_CHANCE : 1)) return;
    const c = circuits[localZ >= 0 ? 'front' : 'rear'];
    const [lo, hi] = PIPE_CRACK_LEAK;
    c.leakLps = Math.min(maxLeakLps, c.leakLps + (lo + (hi - lo) * Math.random()) * maxLeakLps);
  }

  /** Debug: crack a pipe ('front' | 'rear'). */
  function startLeak(circuit = 'front') {
    const c = circuits[circuit];
    c.leakLps = Math.min(maxLeakLps, c.leakLps + DEBUG_LEAK * maxLeakLps);
  }

  /** New disc / drum on wheel i (temperature stays). */
  function repairDisc(i) {
    const d = discs[i];
    if (!d) return;
    d.health = 1;
    d.repair = null;
  }

  /** New pipe on a circuit, bled and topped up. */
  function repairPipe(circuit) {
    circuits[circuit].leakLps = 0;
    circuits[circuit].repair = null;
    brakes.fluidL = capacityL;
  }

  /** New rotors and pipes, topped up (temperatures stay). */
  function repair() {
    discs.forEach((_, i) => repairDisc(i));
    for (const key of Object.keys(circuits)) repairPipe(key);
  }

  function getState() {
    return {
      discs: discs.map((d) => ({ tempC: d.tempC, health: d.health, repair: d.repair })),
      leaks: { front: circuits.front.leakLps, rear: circuits.rear.leakLps },
      pipeRepairs: { front: circuits.front.repair, rear: circuits.rear.repair },
      fluidL: brakes.fluidL,
    };
  }

  /** Restores getState() fields (missing ones stay); temps cool toward `ambient` over `parkedS` s. */
  function setState(state, parkedS = 0, ambient = ambientC) {
    const keep = Math.exp(-Math.max(0, parkedS) / PARKED_COOL_TAU_S);
    if (Array.isArray(state?.discs) && state.discs.length === discs.length) {
      state.discs.forEach((s, i) => {
        if (Number.isFinite(s?.tempC)) discs[i].tempC = ambient + (s.tempC - ambient) * keep;
        if (Number.isFinite(s?.health)) discs[i].health = clamp01(s.health);
        discs[i].repair = readRepairRecord(s?.repair);
      });
    }
    for (const key of Object.keys(circuits)) {
      const leak = state?.leaks?.[key];
      if (Number.isFinite(leak)) circuits[key].leakLps = Math.min(maxLeakLps, Math.max(0, leak));
      circuits[key].repair = readRepairRecord(state?.pipeRepairs?.[key]);
    }
    if (Number.isFinite(state?.fluidL)) brakes.fluidL = Math.min(capacityL, Math.max(0, state.fluidL));
  }

  return brakes;
}
