// Engine + gearbox for wheeled cars: rpm-dependent torque curve through
// gear ratios and final drive, with automatic shifting (sport/comfort) and
// manual override (requestShift), or a fully manual box with neutral
// (setManual/selectGear), optional turbo (boost lag scales torque). Pure math (no physics imports); input.js calls update() each frame.
// Gearbox wear (gearboxWear.js) stretches the shift and synchro times.

import { createGearboxWear } from './gearboxWear.js';

// Drivetrain loss (typical manual gearbox + diff: 8-12%).
const DRIVETRAIN_EFFICIENCY = 0.9;
// Display/sound smoothing of rpm toward the wheel-speed rpm, 1/s (the real
// flywheel inertia lives on the driven wheels via reflectedMass).
const RPM_RESPONSE_PER_S = 25;
// Engine + flywheel rotational inertia (kg m^2).
const DEFAULT_ENGINE_INERTIA = 0.2;
// Closed-throttle drag torque at redline as a fraction of peak torque
// (scales linearly from 0 at idle).
const ENGINE_BRAKE_FRACTION = 0.2;
// Sport auto-shift points as fractions of redline (downshift only if the lower
// gear wouldn't hit redline). Upshifts go by road speed, so wheelspin holds
// the gear and revs into the limiter instead.
const UPSHIFT_RPM_FRACTION = 0.95;
const DOWNSHIFT_RPM_FRACTION = 0.4;
// Comfort shift points as fractions of the idle..redline band, so low-revving
// diesels still shift above idle. Margins keep the gear after a shift inside
// the band (no up/down hunting).
const COMFORT_UPSHIFT_BAND_FRACTION = 0.42;
const COMFORT_DOWNSHIFT_BAND_FRACTION = 0.15;
const COMFORT_HUNT_MARGIN = 1.15;
// After a manual shift the automatic holds off this long.
const MANUAL_HOLD_S = 5;
export const GEAR_MODES = ['sport', 'comfort', 'eco'];
// Pedal cap per automatic mode; eco shifts like comfort.
const MODE_THROTTLE_CAP = { sport: 1, comfort: 0.75, eco: 0.5 };
// On throttle in a slide: drop a gear below this rpm if the lower gear lands
// under SLIDE_TARGET_RPM_FRACTION (gap below the upshift point avoids hunting).
const SLIDE_DOWNSHIFT_RPM_FRACTION = 0.65;
const SLIDE_TARGET_RPM_FRACTION = 0.85;
// Pull-away clutch slip: in 1st/reverse on throttle the engine revs to
// launchRpm (default peakTorqueRpm) and drives from there until the wheels catch up.
// Shift duration and the leading fraction with the clutch open (no torque).
const SHIFT_DURATION_S = 0.35;
const SHIFT_TORQUE_CUT_FRACTION = 0.6;
// Manual box: time in neutral before the synchro lets a gear in (fraction of
// shiftDurationS); a gear selected sooner waits in the slot until then.
const MANUAL_SYNC_FRACTION = 0.35;
// Manual box: engaging against the direction of travel above this (m/s) grinds.
const MANUAL_WRONG_WAY_SPEED = 1;
// Free revving in neutral, 1/s toward redline (throttle) or idle.
const NEUTRAL_REV_UP_PER_S = 5;
const NEUTRAL_REV_DOWN_PER_S = 2.5;
// Rev limiter bounce in neutral: drops back to this fraction of redline.
const NEUTRAL_LIMITER_DROP = 0.94;
// Free revving in neutral only spins the engine up: this share of full-load power (fuel).
const NEUTRAL_LOAD_FRACTION = 0.15;
export const NEUTRAL = -1;
// Turbo: off-boost torque is 1 / (1 + boostBar * gain) of the full-boost curve
// (gain < 1: not all of the extra charge turns into torque). Boost builds from
// half of spoolRpm, full at spoolRpm; it bleeds off faster than it builds (blow-off).
const TURBO_TORQUE_GAIN = 0.6;
const TURBO_SPOOL_START_FRACTION = 0.5;
const TURBO_BLEED_FRACTION = 0.3;
// Manifold vacuum on a closed throttle (bar, gauge reads below 0).
const TURBO_VACUUM_BAR = -0.6;
const DEFAULT_TURBO_LAG_S = 0.6;
// Manual box: most H-gate slots; longer boxes split over parallel ranges.
const MAX_GATE_SLOTS = 6;
const RANGE_LETTERS = { 2: ['L', 'H'], 3: ['L', 'M', 'H'] };

const RAD_S_TO_RPM = 60 / (2 * Math.PI);
// Torque-curve samples when finding its peak power (for loadFraction).
const POWER_CURVE_SAMPLES = 64;

// Defaults for any descriptor field left unset (baseline rally car).
export const DEFAULT_ENGINE_PROFILE = {
  idleRpm: 900,
  redlineRpm: 6500,
  peakTorqueRpm: 4200,
  peakTorqueNm: 180,
  gearRatios: [3.6, 2.1, 1.4, 1.0, 0.8],
  finalDriveRatio: 4.1,
  reverseRatio: 3.3,
};

/**
 * Descriptor fields for a range-change box: every main-box ratio times every
 * range ratio (lowest range first), e.g. 4 main x 3 ranges = 12 gears.
 */
export function rangeGearbox(mainRatios, rangeRatios) {
  return {
    gearRatios: rangeRatios.flatMap((range) => mainRatios.map((main) => main * range)),
    gearRanges: rangeRatios.length,
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Torque fraction: ~60% at idle, 100% at peakTorqueRpm, ~65% at redline,
 * then a hard rev-limiter cut.
 */
function torqueAtRpm(rpm, { idleRpm, peakTorqueRpm, redlineRpm, peakTorqueNm }) {
  if (rpm <= idleRpm) return peakTorqueNm * 0.6;
  if (rpm <= peakTorqueRpm) {
    return lerp(0.6, 1, (rpm - idleRpm) / (peakTorqueRpm - idleRpm)) * peakTorqueNm;
  }
  if (rpm <= redlineRpm) {
    return lerp(1, 0.65, (rpm - peakTorqueRpm) / (redlineRpm - peakTorqueRpm)) * peakTorqueNm;
  }
  return peakTorqueNm * 0.05; // rev limiter bounce - almost no drive torque past redline
}

/** Engine/gearbox state for a wheeled vehicle descriptor (fields default to DEFAULT_ENGINE_PROFILE). */
export function createEngineState(descriptor, wheelRadius) {
  const profile = {
    idleRpm: descriptor.idleRpm ?? DEFAULT_ENGINE_PROFILE.idleRpm,
    redlineRpm: descriptor.redlineRpm ?? DEFAULT_ENGINE_PROFILE.redlineRpm,
    peakTorqueRpm: descriptor.peakTorqueRpm ?? DEFAULT_ENGINE_PROFILE.peakTorqueRpm,
    peakTorqueNm: descriptor.peakTorqueNm ?? DEFAULT_ENGINE_PROFILE.peakTorqueNm,
    gearRatios: descriptor.gearRatios ?? DEFAULT_ENGINE_PROFILE.gearRatios,
    finalDriveRatio: descriptor.finalDriveRatio ?? DEFAULT_ENGINE_PROFILE.finalDriveRatio,
    reverseRatio: descriptor.reverseRatio ?? DEFAULT_ENGINE_PROFILE.reverseRatio,
    shiftDurationS: descriptor.shiftDurationS ?? SHIFT_DURATION_S,
    launchRpm: descriptor.launchRpm ?? descriptor.peakTorqueRpm ?? DEFAULT_ENGINE_PROFILE.peakTorqueRpm,
    engineInertia: descriptor.engineInertia ?? DEFAULT_ENGINE_INERTIA,
  };
  // descriptor.turbo: { boostBar, spoolRpm, lagS }; peakTorqueNm is the full-boost figure.
  const turbo = descriptor.turbo
    ? {
        maxBoostBar: descriptor.turbo.boostBar,
        spoolRpm: descriptor.turbo.spoolRpm ?? profile.peakTorqueRpm,
        lagS: descriptor.turbo.lagS ?? DEFAULT_TURBO_LAG_S,
        offBoostFraction: 1 / (1 + descriptor.turbo.boostBar * TURBO_TORQUE_GAIN),
      }
    : null;
  let peakCurvePower = 0; // max torque x rpm up to redline (Nm rpm)
  for (let i = 0; i <= POWER_CURVE_SAMPLES; i++) {
    const rpm = profile.idleRpm + ((profile.redlineRpm - profile.idleRpm) * i) / POWER_CURVE_SAMPLES;
    peakCurvePower = Math.max(peakCurvePower, torqueAtRpm(rpm, profile) * rpm);
  }

  const engine = {
    // Read by the tachometer/gear HUD.
    rpm: profile.idleRpm,
    gear: 1, // 1..gearRatios.length = forward gears, 0 = reverse, NEUTRAL (manual box only)
    gearCount: profile.gearRatios.length,
    idleRpm: profile.idleRpm,
    redlineRpm: profile.redlineRpm,
    // Redline in the tallest gear (km/h) - sizes the speedo scale.
    topSpeedKmh: ((profile.redlineRpm / RAD_S_TO_RPM) / (Math.min(...profile.gearRatios.map(Math.abs)) * profile.finalDriveRatio)) * wheelRadius * 3.6,
    shiftTimer: 0,
    manualHoldTimer: 0, // >0 while a manual shift suspends the automatic
    automatic: descriptor.automaticGearbox === true, // no fully manual mode
    manual: false, // fully manual box (setManual)
    mass: descriptor.mass,
    neutralTimer: 0, // s since the manual box went into neutral
    keyTarget: null, // gear a manual-box Q/E shift engages once synchronised
    onGearEvent: null, // (type: 'detach' | 'attach' | 'grind', engine) => void
    // Driveline coupling for the wheels, refreshed by update(); totals across
    // all driven wheels. 0 / Infinity while the clutch is open mid-shift.
    reflectedMass: 0, // engine inertia seen at the tread (kg)
    limitWheelSpeed: Infinity, // tread speed at redline in this gear (m/s)
    engineBrakeForce: 0, // closed-throttle drag at the tread (N)
    loadFraction: 0, // brake power now / peak power (0..1), refreshed by update(); fuel.js burns by it
    throttle: 0, // throttle actually applied (0..1, 0 while braking/coasting), refreshed by update()
    powerFactor: 1, // torque multiplier from outside (car.js: overheating limp mode)
    gearbox: createGearboxWear(), // health: over-rev downshifts and hits slow the shifts
    turbo, // null for naturally aspirated engines; boost gauge reads turbo.maxBoostBar
    boostBar: 0, // manifold pressure over atmospheric (bar), negative = vacuum
    get boostFraction() {
      return turbo ? Math.max(0, engine.boostBar) / turbo.maxBoostBar : 0;
    },
    get gearLabel() {
      if (engine.gear === 0) return 'R';
      if (engine.gear === NEUTRAL) return 'N';
      if (engine.gearRanges === 1) return String(engine.gear);
      return `${mainGearOf(engine.gear)}${RANGE_LETTERS[engine.gearRanges]?.[rangeOf(engine.gear)] ?? rangeOf(engine.gear) + 1}`;
    },
  };
  // Range-change box: forward gear g = range * gearSlots + main gear.
  engine.gearRanges = descriptor.gearRanges ?? Math.ceil(engine.gearCount / MAX_GATE_SLOTS);
  engine.gearSlots = Math.ceil(engine.gearCount / engine.gearRanges);
  engine.range = 0; // range stage engaged (or preselected in N/R), 0 = lowest

  function rangeOf(gear) {
    return Math.floor((gear - 1) / engine.gearSlots);
  }

  function mainGearOf(gear) {
    return ((gear - 1) % engine.gearSlots) + 1;
  }

  /** Same main gear in range `r`, or null when that range has no such gear. */
  function gearInRange(gear, r) {
    const target = mainGearOf(gear) + r * engine.gearSlots;
    return target <= engine.gearCount ? target : null;
  }

  function ratioForGear(gear) {
    return gear === 0 ? profile.reverseRatio : profile.gearRatios[gear - 1];
  }

  /** Engine rpm for a wheel angular speed (rad/s) through a gear ratio. */
  function toRpm(angularSpeed, gearRatio) {
    return angularSpeed * Math.abs(gearRatio) * profile.finalDriveRatio * RAD_S_TO_RPM;
  }

  function shiftDuration() {
    return profile.shiftDurationS * engine.gearbox.shiftFactor;
  }

  function shiftTo(gear) {
    engine.gear = gear;
    engine.shiftTimer = shiftDuration();
    if (gear >= 1) engine.range = rangeOf(gear);
  }

  /** Spools the turbo toward the boost this throttle and rpm can make; returns the torque multiplier. */
  function updateBoost(dt, throttle, rpm) {
    if (!turbo) return 1;
    const spoolStart = turbo.spoolRpm * TURBO_SPOOL_START_FRACTION;
    const available = Math.min(1, Math.max(0, (rpm - spoolStart) / (turbo.spoolRpm - spoolStart)));
    const target = throttle > 0 ? turbo.maxBoostBar * available * throttle : TURBO_VACUUM_BAR;
    const tau = turbo.lagS * (target > engine.boostBar ? 1 : TURBO_BLEED_FRACTION);
    engine.boostBar += (target - engine.boostBar) * Math.min(1, dt / Math.max(tau, 1e-3));
    return turbo.offBoostFraction + (1 - turbo.offBoostFraction) * engine.boostFraction;
  }

  // Net requested manual gear steps since the last update.
  let pendingShift = 0;
  let forwardSpeed = 0; // signed chassis speed at the last update (m/s)
  let driveSpeed = 0; // faster of driven-wheel tread and ground speed at the last update (m/s)

  /** Requests a manual up (+1) or down (-1) shift; presses accumulate. */
  function requestShift(step) {
    if (engine.manual) manualStep(Math.sign(step));
    else pendingShift += Math.sign(step);
  }

  function emit(type) {
    engine.onGearEvent?.(type, engine);
  }

  /** Fully manual box on/off; never on for automatics. Back to automatic leaves neutral in 1st. */
  function setManual(on) {
    const manual = on && !engine.automatic;
    if (manual === engine.manual) return;
    engine.manual = manual;
    engine.keyTarget = null;
    pendingShift = 0;
    if (!manual && engine.gear === NEUTRAL) shiftTo(1);
  }

  function disengage() {
    engine.gear = NEUTRAL;
    engine.neutralTimer = 0;
    engine.shiftTimer = 0;
    emit('detach');
  }

  function synchronised() {
    return engine.neutralTimer >= shiftDuration() * MANUAL_SYNC_FRACTION;
  }

  function rightWay(gear) {
    return gear === 0 ? forwardSpeed < MANUAL_WRONG_WAY_SPEED : forwardSpeed > -MANUAL_WRONG_WAY_SPEED;
  }

  /**
   * Manual box: puts the lever in `gear` (NEUTRAL, 0 = R, 1..gearCount). From a
   * gear it goes out first; before the synchro time is up the gear waits
   * (keyTarget) and goes in from update(). Against the direction of travel it
   * grinds: returns false, left in neutral.
   */
  function selectGear(gear) {
    if (!engine.manual) return true;
    if (gear === engine.gear) {
      engine.keyTarget = null;
      return true;
    }
    engine.keyTarget = null;
    if (engine.gear !== NEUTRAL) disengage();
    if (gear === NEUTRAL) return true;
    if (!rightWay(gear)) {
      emit('grind');
      return false;
    }
    if (!synchronised()) {
      engine.keyTarget = gear;
      return true;
    }
    engine.gear = gear;
    if (gear >= 1) {
      engine.range = rangeOf(gear);
      engine.gearbox.overRev(toRpm(driveSpeed / wheelRadius, ratioForGear(gear)) / profile.redlineRpm);
    }
    emit('attach');
    return true;
  }

  // Q/E on the manual box step through R, N, 1..gearCount; a gear goes out at
  // once and the next one in after the synchro time (update).
  function manualStep(step) {
    const order = (gear) => (gear === 0 ? 0 : gear === NEUTRAL ? 1 : gear + 1);
    const from = engine.keyTarget ?? engine.gear;
    const index = Math.min(engine.gearCount + 1, Math.max(0, order(from) + step));
    const target = index === 0 ? 0 : index === 1 ? NEUTRAL : index - 1;
    if (target === from) return;
    if (engine.gear !== NEUTRAL) disengage();
    engine.keyTarget = target === NEUTRAL ? null : target;
    if (target >= 1 && rangeOf(target) !== engine.range) {
      engine.range = rangeOf(target);
      emit('range');
    }
  }

  /**
   * Manual box range lever. In a forward gear the main gear stays in and the
   * range stage shifts under a torque cut (shiftDurationS); in N/R it only
   * preselects. Refused (false) when that range lacks the current main gear.
   */
  function setRange(r) {
    if (!engine.manual) return false;
    const range = Math.min(engine.gearRanges - 1, Math.max(0, r));
    if (range === engine.range) return true;
    const engaged = engine.gear >= 1 ? gearInRange(engine.gear, range) : NEUTRAL;
    const pending = engine.keyTarget >= 1 ? gearInRange(engine.keyTarget, range) : NEUTRAL;
    if (engaged === null || pending === null) return false;
    engine.range = range;
    if (engine.gear >= 1) shiftTo(engaged);
    if (engine.keyTarget >= 1) engine.keyTarget = pending;
    emit('range');
    return true;
  }

  /**
   * Advances rpm/gearbox by `dt` and returns the drive force (N, unsigned).
   * direction: 1 forward, -1 reverse, 0 coasting/braking (rpm still tracks).
   * throttle: 0..1. wheelSpeedAbs: unsigned driven-wheel tread speed (m/s),
   * so wheelspin and airborne throttle rev the engine. groundSpeedAbs:
   * unsigned chassis speed (m/s), picks the upshift point. grounded: no
   * upshifts while the driven wheels are in the air. slipping: driven wheels
   * sliding: on throttle it drops gears to keep rpm high, else it holds.
   * mode: 'sport' (late shifts, slide downshifts), 'comfort' (early shifts, 75% pedal)
   * or 'eco' (early shifts, 50% pedal); manual ignores it.
   */
  function update(dt, { direction, throttle, wheelSpeedAbs, groundSpeedAbs = wheelSpeedAbs, forwardSpeed: signedSpeed = 0, grounded = true, slipping = false, mode = 'sport' }) {
    forwardSpeed = signedSpeed;
    driveSpeed = Math.max(0, wheelSpeedAbs, groundSpeedAbs);
    engine.gearbox.tick(dt);
    if (engine.shiftTimer > 0) engine.shiftTimer = Math.max(0, engine.shiftTimer - dt);
    if (engine.manualHoldTimer > 0) engine.manualHoldTimer = Math.max(0, engine.manualHoldTimer - dt);

    if (engine.manual) {
      if (engine.gear === NEUTRAL) {
        engine.neutralTimer += dt;
        if (engine.keyTarget !== null && synchronised()) {
          selectGear(engine.keyTarget);
        }
      }
      if (engine.gear === NEUTRAL) return updateNeutral(dt, throttle);
    } else if (direction === -1 && engine.gear !== 0) {
      // Engage the gear for the requested direction; forward restarts in 1st.
      shiftTo(0);
    } else if (direction === 1 && engine.gear === 0) {
      shiftTo(1);
    }

    const wheelAngularSpeed = Math.max(0, wheelSpeedAbs) / wheelRadius; // rad/s
    const groundAngularSpeed = Math.max(0, groundSpeedAbs) / wheelRadius;

    // Manual shift (forward gears only). A press mid-shift retargets the shift in
    // progress instead of queuing another, so quick presses skip gears. Downshifts
    // stop at the lowest gear that doesn't over-rev.
    if (pendingShift !== 0) {
      if (engine.gear >= 1) {
        let target = Math.min(engine.gearCount, Math.max(1, engine.gear + pendingShift));
        while (target < engine.gear && toRpm(Math.max(wheelAngularSpeed, groundAngularSpeed), profile.gearRatios[target - 1]) >= profile.redlineRpm) target++;
        if (target !== engine.gear) {
          if (engine.shiftTimer > 0) engine.gear = target;
          else shiftTo(target);
          engine.manualHoldTimer = MANUAL_HOLD_S;
        }
      }
      pendingShift = 0;
    }

    const ratio = Math.abs(ratioForGear(engine.gear));
    // Below idle the clutch slips, so the engine never stalls.
    const wheelRpm = Math.max(profile.idleRpm, toRpm(wheelAngularSpeed, ratio));
    const launching = engine.gear <= 1 && direction !== 0 && throttle > 0 && wheelRpm < profile.launchRpm;
    const smoothing = Math.min(1, dt * RPM_RESPONSE_PER_S);
    engine.rpm += ((launching ? profile.launchRpm : wheelRpm) - engine.rpm) * smoothing;
    engine.rpm = Math.min(engine.rpm, profile.redlineRpm * 1.02);

    // Auto-shift (forward only, on the ground), one shift at a time.
    if (!engine.manual && engine.gear >= 1 && engine.shiftTimer <= 0 && engine.manualHoldTimer <= 0 && grounded) {
      const groundRpm = toRpm(groundAngularSpeed, ratio);
      const upshiftRpm = Math.min(engine.rpm, groundRpm);
      const shift = mode !== 'sport' ? comfortShift(upshiftRpm, groundRpm, wheelAngularSpeed, ratio) : sportShift(upshiftRpm, groundRpm, wheelAngularSpeed, ratio, direction, throttle, slipping);
      if (shift !== 0) shiftTo(engine.gear + shift);
    }

    // Gear may have changed above.
    const totalRatio = Math.abs(ratioForGear(engine.gear)) * profile.finalDriveRatio;
    const inTorqueCut = engine.shiftTimer > shiftDuration() * (1 - SHIFT_TORQUE_CUT_FRACTION);
    const throttleCap = engine.manual ? 1 : MODE_THROTTLE_CAP[mode] ?? 1;
    const clampedThrottle = direction === 0 ? 0 : Math.min(throttleCap, Math.max(0, throttle));
    engine.throttle = clampedThrottle;
    // Pedal (not the shift cut) drives the boost, so flat shifts keep the turbo spooled.
    const boostMultiplier = updateBoost(dt, clampedThrottle, engine.rpm);
    // Torque from the unsmoothed wheel rpm, so the limiter bites immediately;
    // while the clutch slips at pull-away, from the revving engine instead.
    const torqueRpm = launching ? Math.max(wheelRpm, engine.rpm) : wheelRpm;
    const engineTorqueNm = inTorqueCut ? 0 : torqueAtRpm(torqueRpm, profile) * clampedThrottle * boostMultiplier * engine.powerFactor;
    const torqueToForce = (totalRatio * DRIVETRAIN_EFFICIENCY) / wheelRadius;
    const totalDrivetrainForce = engineTorqueNm * torqueToForce;
    engine.loadFraction = Math.min(1, (engineTorqueNm * torqueRpm) / peakCurvePower);

    const rpmFraction = Math.max(0, (wheelRpm - profile.idleRpm) / (profile.redlineRpm - profile.idleRpm));
    const brakeTorqueNm = clampedThrottle > 0 ? 0 : profile.peakTorqueNm * ENGINE_BRAKE_FRACTION * Math.min(1, rpmFraction);
    // A slipping clutch doesn't couple the engine's inertia to the wheels.
    engine.reflectedMass = inTorqueCut || launching ? 0 : (profile.engineInertia * totalRatio * totalRatio) / (wheelRadius * wheelRadius);
    engine.limitWheelSpeed = inTorqueCut ? Infinity : ((profile.redlineRpm / RAD_S_TO_RPM) / totalRatio) * wheelRadius;
    engine.engineBrakeForce = inTorqueCut ? 0 : brakeTorqueNm * torqueToForce;

    // Halved: input.js treats this as a per-wheel value at the 2-wheel
    // baseline and multiplies back by the driven-wheel count.
    return totalDrivetrainForce / 2;
  }

  /** Clutch out of the driveline: the engine revs freely, no drive or engine braking. */
  function updateNeutral(dt, throttle) {
    const revving = throttle > 0;
    const boostMultiplier = updateBoost(dt, Math.max(0, throttle), engine.rpm);
    const target = revving ? profile.redlineRpm * 1.02 : profile.idleRpm;
    engine.rpm += (target - engine.rpm) * Math.min(1, dt * (revving ? NEUTRAL_REV_UP_PER_S * boostMultiplier : NEUTRAL_REV_DOWN_PER_S));
    if (engine.rpm > profile.redlineRpm) engine.rpm = profile.redlineRpm * NEUTRAL_LIMITER_DROP;
    engine.reflectedMass = 0;
    engine.limitWheelSpeed = Infinity;
    engine.engineBrakeForce = 0;
    engine.throttle = Math.max(0, throttle);
    engine.loadFraction = (engine.throttle * NEUTRAL_LOAD_FRACTION * boostMultiplier * engine.powerFactor * torqueAtRpm(engine.rpm, profile) * engine.rpm) / peakCurvePower;
    return 0;
  }

  /** Current-gear shift decision for sport: +1, -1 or 0. */
  function sportShift(upshiftRpm, groundRpm, wheelAngularSpeed, ratio, direction, throttle, slipping) {
    if (upshiftRpm > profile.redlineRpm * UPSHIFT_RPM_FRACTION && engine.gear < engine.gearCount) return 1;
    if (engine.gear <= 1) return 0;
    const lowerRatio = Math.abs(profile.gearRatios[engine.gear - 2]);
    const lowerRpm = toRpm(wheelAngularSpeed, lowerRatio);
    // Road speed too, so locked (handbraked) wheels don't drop it into an over-revving gear.
    const lowerGroundRpm = groundRpm * (lowerRatio / ratio);
    const slideDownshift =
      slipping &&
      direction === 1 &&
      throttle > 0 &&
      engine.rpm < profile.redlineRpm * SLIDE_DOWNSHIFT_RPM_FRACTION &&
      Math.max(lowerRpm, lowerGroundRpm) < profile.redlineRpm * SLIDE_TARGET_RPM_FRACTION;
    const normalDownshift =
      !slipping &&
      engine.rpm < profile.redlineRpm * DOWNSHIFT_RPM_FRACTION &&
      lowerRpm < profile.redlineRpm * UPSHIFT_RPM_FRACTION;
    return slideDownshift || normalDownshift ? -1 : 0;
  }

  /** Current-gear shift decision for comfort: +1, -1 or 0. */
  function comfortShift(upshiftRpm, groundRpm, wheelAngularSpeed, ratio) {
    const band = profile.redlineRpm - profile.idleRpm;
    const upAt = profile.idleRpm + band * COMFORT_UPSHIFT_BAND_FRACTION;
    const downAt = profile.idleRpm + band * COMFORT_DOWNSHIFT_BAND_FRACTION;
    if (engine.gear < engine.gearCount) {
      const nextRpm = upshiftRpm * (Math.abs(profile.gearRatios[engine.gear]) / ratio);
      const roomAfterShift = nextRpm > downAt * COMFORT_HUNT_MARGIN;
      if ((upshiftRpm > upAt && roomAfterShift) || upshiftRpm > profile.redlineRpm * UPSHIFT_RPM_FRACTION) return 1;
    }
    if (engine.gear <= 1 || engine.rpm >= downAt) return 0;
    const lowerRatio = Math.abs(profile.gearRatios[engine.gear - 2]);
    const lowerRpm = toRpm(wheelAngularSpeed, lowerRatio);
    const lowerGroundRpm = groundRpm * (lowerRatio / ratio);
    return Math.max(lowerRpm, lowerGroundRpm) * COMFORT_HUNT_MARGIN < upAt ? -1 : 0;
  }

  engine.update = update;
  engine.requestShift = requestShift;
  engine.setManual = setManual;
  engine.selectGear = selectGear;
  engine.setRange = setRange;
  return engine;
}
