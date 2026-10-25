// Engine warm-up and cooling: three lumped heat masses (block, coolant, oil).
// Combustion heat goes into the block (and partly straight into the oil:
// friction, piston cooling), the block passes it to the coolant and oil, the
// coolant sheds it through the radiator once the thermostat opens, with ram air
// from road speed plus an electric fan when hot. Block, oil and radiator scale
// with rated power, so every engine warms up on a similar clock; descriptor
// `radiator` (capacity multiplier) and `coolantL` (system volume) tell cars apart.
// Starts at the outside temperature. Coolant can leak (radiator hits, boiling
// over); a low level starves the pump, and an overheating engine loses power.
// Oil (descriptor `oilL`) burns slowly at high rpm and leaks from a sump cracked by
// underbody hits; a low level starves the oil flow, so the oil overheats and derates too.

const W_PER_HP = 745.7;
// Heat into the cooling system per watt of brake power (roughly one third of the fuel energy).
const HEAT_PER_BRAKE_W = 1.0;
// Running heat (friction, pumping) as a fraction of rated power at idle rpm; grows with rpm.
const IDLE_HEAT_FRACTION = 0.025;
// Share of the heat that lands in the oil directly.
const OIL_HEAT_SHARE = 0.2;
// Heat capacities: block and oil J/K per rated kW (~90 kg of iron, 5 L oil for 100 kW), coolant J/K per litre.
const BLOCK_J_PER_K_KW = 400;
const OIL_J_PER_K_KW = 100;
const COOLANT_J_PER_K_L = 3800;
// Default system volume: litres + litres per rated kW.
const DEFAULT_COOLANT_BASE_L = 2.5;
const DEFAULT_COOLANT_L_PER_KW = 0.04;
const DEFAULT_RADIATOR = 1;
// Conductances, W/K per rated kW.
const BLOCK_COOLANT_W_PER_K_KW = 50;
const BLOCK_OIL_W_PER_K_KW = 12;
const RADIATOR_W_PER_K_KW = 12; // radiator 1, fully open thermostat at full airflow
const OIL_AIR_W_PER_K_KW = 1.2; // sump / oil cooler at full airflow
const BLOCK_AIR_W_PER_K_KW = 0.5; // engine bay at full airflow
// Thermostat: starts opening / fully open (°C); a closed one still bypasses a little.
const THERMOSTAT_OPEN_C = 88;
const THERMOSTAT_FULL_C = 98;
const THERMOSTAT_LEAK = 0.05;
// Working temperatures of a warmed-up engine (event start), °C.
const WARM_BLOCK_C = 92;
const WARM_COOLANT_C = 90;
const WARM_OIL_C = 90;
// Airflow 0..1: still air, ram air full at this speed, the fan's equivalent speed.
const STILL_AIR = 0.06;
const FULL_AIRFLOW_MS = 30;
const FAN_AIRFLOW_MS = 15;
// Fan switches on / off (°C coolant).
const FAN_ON_C = 102;
const FAN_OFF_C = 97;
// Level fraction: full circulation above, none (pump sucks air) below; the block keeps this much contact without it.
const FULL_FLOW_LEVEL = 0.75;
const DRY_LEVEL = 0.2;
const DRY_BLOCK_CONTACT = 0.15;
// Heat mass floor for a near-empty system (stability), litres.
const MIN_COOLANT_L = 0.3;
// Leaks (L/s at full system pressure): a hit adds to the rate, a cold system leaks at the floor share.
const LEAK_MIN_HIT_MS = 6; // front impact speed that starts cracking the radiator
const LEAK_MAX_HIT_MS = 22; // ... and the one that opens it fully
const LEAK_MAX_LPS = 0.08;
const DEBUG_LEAK_LPS = 0.02;
// One crash fires contacts over several steps: within this window only the hardest one counts.
const HIT_WINDOW_S = 0.5;
const COLD_PRESSURE = 0.3;
// Pressure cap: above this the coolant boils over and vents, L/s per kelvin over.
const BOIL_C = 124;
const BOIL_LPS_PER_K = 0.004;
// Coolant lamp from this temperature (the aux gauge's red band) or below this level.
export const COOLANT_HOT_C = 115;
const LOW_LEVEL = 0.6;
// Limp mode: power falls from 1 at this coolant temperature to the floor at the second.
const DERATE_FROM_C = 118;
const DERATE_FULL_C = 135;
const DERATE_FLOOR = 0.4;
// Parked engine cooling toward the outside air, time constant (s), for a restored save.
const PARKED_COOL_TAU_S = 45 * 60;
// Oil system volume: litres + litres per rated kW (~5 L for 100 kW); heat mass floor (L).
const DEFAULT_OIL_BASE_L = 3;
const DEFAULT_OIL_L_PER_KW = 0.02;
const MIN_OIL_L = 0.3;
// Burn at redline (L/h), falling with the square of rpm.
const OIL_BURN_LPH = 0.15;
// Oil level fraction: full flow above, starved below; the oil keeps this much contact without it.
const OIL_FULL_FLOW_LEVEL = 0.6;
const OIL_DRY_LEVEL = 0.15;
const OIL_DRY_CONTACT = 0.15;
// Sump cracks (L/s): underbody impact speed that starts one, the one that opens it fully.
const SUMP_MIN_HIT_MS = 4;
const SUMP_MAX_HIT_MS = 14;
const SUMP_MAX_LPS = 0.02;
// Oil lamp from this temperature or below OIL_FULL_FLOW_LEVEL; limp mode from / at the floor.
const OIL_HOT_C = 140;
const OIL_DERATE_FROM_C = 140;
const OIL_DERATE_FULL_C = 165;
// Integration step cap (s); the stiffest pair (block-coolant) settles in ~8 s.
const MAX_STEP_S = 0.05;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Heat state for a wheeled engine descriptor, starting cold at `ambientC`. */
export function createEngineHeat(descriptor, ambientC) {
  const ratedKw = ((descriptor.enginePowerHp ?? 100) * W_PER_HP) / 1000;
  const ratedW = ratedKw * 1000;
  const idleRpm = descriptor.idleRpm ?? 800;
  const capacityL = descriptor.coolantL ?? DEFAULT_COOLANT_BASE_L + DEFAULT_COOLANT_L_PER_KW * ratedKw;
  const radiatorSize = descriptor.radiator ?? DEFAULT_RADIATOR;
  const blockC = BLOCK_J_PER_K_KW * ratedKw;
  const oilFullC = OIL_J_PER_K_KW * ratedKw;
  const oilCapacityL = descriptor.oilL ?? DEFAULT_OIL_BASE_L + DEFAULT_OIL_L_PER_KW * ratedKw;
  const redlineRpm = descriptor.redlineRpm ?? 6000;
  let clock = 0; // s of update() time
  const radiatorHits = { until: -Infinity, severity: 0 }; // hardest hit in the current window
  const sumpHits = { until: -Infinity, severity: 0 };

  const heat = {
    blockTempC: ambientC,
    coolantTempC: ambientC,
    oilTempC: ambientC,
    ambientC,
    capacityL,
    radiator: radiatorSize,
    coolantL: capacityL,
    leakLps: 0, // radiator leak at full pressure
    oilCapacityL,
    oilL: oilCapacityL,
    oilLeakLps: 0, // cracked sump
    sealed: false, // editor: no coolant or oil is lost
    radiatorRepair: null, // lib/partRepair.js records, cleared by a new part
    sumpRepair: null,
    lossLps: 0, // last step: leak + boil-over, for the debug HUD
    heatInW: 0,
    radiatorW: 0,
    thermostat: 0, // opening 0..1
    fanOn: false,
    get level() {
      return heat.coolantL / capacityL;
    },
    get coolantHot() {
      return heat.coolantTempC >= COOLANT_HOT_C;
    },
    get coolantWarning() {
      return heat.coolantHot || heat.level < LOW_LEVEL;
    },
    get oilLevel() {
      return heat.oilL / oilCapacityL;
    },
    get oilWarning() {
      return heat.oilTempC >= OIL_HOT_C || heat.oilLevel < OIL_FULL_FLOW_LEVEL;
    },
    /** Engine torque multiplier, below 1 in limp mode. */
    get powerFactor() {
      const coolant = clamp01((heat.coolantTempC - DERATE_FROM_C) / (DERATE_FULL_C - DERATE_FROM_C));
      const oil = clamp01((heat.oilTempC - OIL_DERATE_FROM_C) / (OIL_DERATE_FULL_C - OIL_DERATE_FROM_C));
      return 1 - (1 - DERATE_FLOOR) * Math.max(coolant, oil);
    },
    /** 1 sealed .. 0 leaking at the worst rate. */
    get radiatorHealth() {
      return 1 - heat.leakLps / LEAK_MAX_LPS;
    },
    set radiatorHealth(h) {
      heat.leakLps = (1 - clamp01(h)) * LEAK_MAX_LPS;
    },
    get sumpHealth() {
      return 1 - heat.oilLeakLps / SUMP_MAX_LPS;
    },
    set sumpHealth(h) {
      heat.oilLeakLps = (1 - clamp01(h)) * SUMP_MAX_LPS;
    },
    update,
    hitRadiator,
    hitSump,
    startLeak,
    repair,
    repairRadiator,
    repairSump,
    warmUp,
    getState,
    setState,
  };

  /** Advances `dt` s at the engine's current load and rpm; `speedMs` = air past the radiator. */
  function update(dt, engine, speedMs, ambient = heat.ambientC) {
    if (dt <= 0) return;
    clock += dt;
    heat.ambientC = ambient;
    const rpmRatio = Math.max(1, engine.rpm / idleRpm);
    heat.heatInW = ratedW * ((engine.loadFraction ?? 0) * HEAT_PER_BRAKE_W + IDLE_HEAT_FRACTION * rpmRatio);
    const steps = Math.ceil(dt / MAX_STEP_S);
    const h = dt / steps;
    for (let i = 0; i < steps; i++) step(h, speedMs, ambient);
    if (heat.sealed) return;
    const burnLps = (OIL_BURN_LPH / 3600) * Math.min(1, engine.rpm / redlineRpm) ** 2;
    heat.oilL = Math.max(0, heat.oilL - (burnLps + heat.oilLeakLps) * dt);
  }

  function step(h, speedMs, ambient) {
    if (heat.coolantTempC >= FAN_ON_C) heat.fanOn = true;
    else if (heat.coolantTempC <= FAN_OFF_C) heat.fanOn = false;
    const airMs = Math.max(Math.abs(speedMs), heat.fanOn ? FAN_AIRFLOW_MS : 0);
    const airflow = Math.min(1, STILL_AIR + airMs / FULL_AIRFLOW_MS);
    const open = clamp01((heat.coolantTempC - THERMOSTAT_OPEN_C) / (THERMOSTAT_FULL_C - THERMOSTAT_OPEN_C));
    heat.thermostat = open;
    const flow = clamp01((heat.level - DRY_LEVEL) / (FULL_FLOW_LEVEL - DRY_LEVEL));
    const coolantC = COOLANT_J_PER_K_L * Math.max(MIN_COOLANT_L, heat.coolantL);
    const oilFlow = OIL_DRY_CONTACT + (1 - OIL_DRY_CONTACT) * clamp01((heat.oilLevel - OIL_DRY_LEVEL) / (OIL_FULL_FLOW_LEVEL - OIL_DRY_LEVEL));
    const oilC = oilFullC * (Math.max(MIN_OIL_L, heat.oilL) / oilCapacityL);

    const { blockTempC: b, coolantTempC: c, oilTempC: o } = heat;
    const toCoolant = BLOCK_COOLANT_W_PER_K_KW * ratedKw * (DRY_BLOCK_CONTACT + (1 - DRY_BLOCK_CONTACT) * flow) * (b - c);
    const toOil = BLOCK_OIL_W_PER_K_KW * ratedKw * oilFlow * (b - o);
    const radiator = RADIATOR_W_PER_K_KW * ratedKw * radiatorSize * flow * (THERMOSTAT_LEAK + (1 - THERMOSTAT_LEAK) * open) * airflow * (c - ambient);
    const oilToAir = OIL_AIR_W_PER_K_KW * ratedKw * oilFlow * airflow * (o - ambient);
    const blockToAir = BLOCK_AIR_W_PER_K_KW * ratedKw * airflow * (b - ambient);
    heat.radiatorW = radiator;

    heat.blockTempC += ((1 - OIL_HEAT_SHARE) * heat.heatInW - toCoolant - toOil - blockToAir) * h / blockC;
    heat.coolantTempC += (toCoolant - radiator) * h / coolantC;
    heat.oilTempC += (OIL_HEAT_SHARE * heat.heatInW + toOil - oilToAir) * h / oilC;

    // The system pressurises as it warms through the thermostat range.
    const pressure = COLD_PRESSURE + (1 - COLD_PRESSURE) * clamp01((c - ambient) / Math.max(1, THERMOSTAT_OPEN_C - ambient));
    heat.lossLps = heat.coolantL > 0 && !heat.sealed ? heat.leakLps * pressure + Math.max(0, c - BOIL_C) * BOIL_LPS_PER_K : 0;
    heat.coolantL = Math.max(0, heat.coolantL - heat.lossLps * h);
  }

  /** Hardest-hit-in-the-window share of `severity` not yet counted (0 when a harder one already was). */
  function newSeverity(hits, severity) {
    if (severity <= 0) return 0;
    if (clock > hits.until) hits.severity = 0;
    hits.until = clock + HIT_WINDOW_S;
    if (severity <= hits.severity) return 0;
    const extra = severity - hits.severity;
    hits.severity = severity;
    return extra;
  }

  /** Front impact at `speedMs` (along the contact normal): cracks the radiator above LEAK_MIN_HIT_MS. */
  function hitRadiator(speedMs) {
    const extra = newSeverity(radiatorHits, clamp01((speedMs - LEAK_MIN_HIT_MS) / (LEAK_MAX_HIT_MS - LEAK_MIN_HIT_MS)));
    heat.leakLps = Math.min(LEAK_MAX_LPS, heat.leakLps + extra * LEAK_MAX_LPS);
  }

  /** Underbody impact at `speedMs`: cracks the sump above SUMP_MIN_HIT_MS. */
  function hitSump(speedMs) {
    const extra = newSeverity(sumpHits, clamp01((speedMs - SUMP_MIN_HIT_MS) / (SUMP_MAX_HIT_MS - SUMP_MIN_HIT_MS)));
    heat.oilLeakLps = Math.min(SUMP_MAX_LPS, heat.oilLeakLps + extra * SUMP_MAX_LPS);
  }

  /** Debug: a moderate leak. */
  function startLeak() {
    heat.leakLps = Math.min(LEAK_MAX_LPS, heat.leakLps + DEBUG_LEAK_LPS);
  }

  /** New radiator, topped up. */
  function repairRadiator() {
    heat.leakLps = 0;
    heat.radiatorRepair = null;
    heat.coolantL = capacityL;
  }

  /** New sump, topped up. */
  function repairSump() {
    heat.oilLeakLps = 0;
    heat.sumpRepair = null;
    heat.oilL = oilCapacityL;
  }

  /** Fixed radiator and sump, both topped up (temperatures stay). */
  function repair() {
    repairRadiator();
    repairSump();
  }

  /** Repaired and at working temperature, as if warmed up before a start. */
  function warmUp() {
    repair();
    heat.blockTempC = Math.max(heat.blockTempC, WARM_BLOCK_C);
    heat.coolantTempC = Math.max(heat.coolantTempC, WARM_COOLANT_C);
    heat.oilTempC = Math.max(heat.oilTempC, WARM_OIL_C);
  }

  function getState() {
    return {
      blockTempC: heat.blockTempC,
      coolantTempC: heat.coolantTempC,
      oilTempC: heat.oilTempC,
      coolantL: heat.coolantL,
      leakLps: heat.leakLps,
      oilL: heat.oilL,
      oilLeakLps: heat.oilLeakLps,
    };
  }

  /** Restores getState() fields (missing ones stay); temps cool toward the outside air over `parkedS` s. */
  function setState(state, parkedS = 0) {
    const keep = Math.exp(-Math.max(0, parkedS) / PARKED_COOL_TAU_S);
    for (const key of ['blockTempC', 'coolantTempC', 'oilTempC']) {
      if (Number.isFinite(state?.[key])) heat[key] = heat.ambientC + (state[key] - heat.ambientC) * keep;
    }
    if (Number.isFinite(state?.coolantL)) heat.coolantL = Math.min(capacityL, Math.max(0, state.coolantL));
    if (Number.isFinite(state?.leakLps)) heat.leakLps = Math.min(LEAK_MAX_LPS, Math.max(0, state.leakLps));
    if (Number.isFinite(state?.oilL)) heat.oilL = Math.min(oilCapacityL, Math.max(0, state.oilL));
    if (Number.isFinite(state?.oilLeakLps)) heat.oilLeakLps = Math.min(SUMP_MAX_LPS, Math.max(0, state.oilLeakLps));
  }

  return heat;
}
