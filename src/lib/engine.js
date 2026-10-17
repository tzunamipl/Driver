// Engine + gearbox for wheeled cars: rpm-dependent torque curve through
// gear ratios and final drive, with automatic shifting (sport/comfort) and
// manual override (requestShift). Pure math (no
// physics imports); input.js calls update() each frame.

// Drivetrain loss (typical manual gearbox + diff: 8-12%).
const DRIVETRAIN_EFFICIENCY = 0.9;
const DRIVETRAIN_EFFICIENCY_MODIFIER = 0.88;
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
export const GEAR_MODES = ['sport', 'comfort'];
// On throttle in a slide: drop a gear below this rpm if the lower gear lands
// under SLIDE_TARGET_RPM_FRACTION (gap below the upshift point avoids hunting).
const SLIDE_DOWNSHIFT_RPM_FRACTION = 0.65;
const SLIDE_TARGET_RPM_FRACTION = 0.85;
// Pull-away clutch slip: in 1st/reverse on throttle the engine revs to
// launchRpm (default peakTorqueRpm) and drives from there until the wheels catch up.
// Shift duration and the leading fraction with the clutch open (no torque).
const SHIFT_DURATION_S = 0.35;
const SHIFT_TORQUE_CUT_FRACTION = 0.6;

const RAD_S_TO_RPM = 60 / (2 * Math.PI);

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
    shiftDurationS: descriptor.shiftDurationS,
    launchRpm: descriptor.launchRpm ?? descriptor.peakTorqueRpm ?? DEFAULT_ENGINE_PROFILE.peakTorqueRpm,
    engineInertia: descriptor.engineInertia ?? DEFAULT_ENGINE_INERTIA,
  };

  const engine = {
    // Read by the tachometer/gear HUD.
    rpm: profile.idleRpm,
    gear: 1, // 1..gearRatios.length = forward gears, 0 = reverse
    gearCount: profile.gearRatios.length,
    idleRpm: profile.idleRpm,
    redlineRpm: profile.redlineRpm,
    shiftTimer: 0,
    manualHoldTimer: 0, // >0 while a manual shift suspends the automatic
    // Driveline coupling for the wheels, refreshed by update(); totals across
    // all driven wheels. 0 / Infinity while the clutch is open mid-shift.
    reflectedMass: 0, // engine inertia seen at the tread (kg)
    limitWheelSpeed: Infinity, // tread speed at redline in this gear (m/s)
    engineBrakeForce: 0, // closed-throttle drag at the tread (N)
    get gearLabel() {
      return engine.gear === 0 ? 'R' : String(engine.gear);
    },
  };

  function ratioForGear(gear) {
    return gear === 0 ? profile.reverseRatio : profile.gearRatios[gear - 1];
  }

  /** Engine rpm for a wheel angular speed (rad/s) through a gear ratio. */
  function toRpm(angularSpeed, gearRatio) {
    return angularSpeed * Math.abs(gearRatio) * profile.finalDriveRatio * RAD_S_TO_RPM;
  }

  function shiftTo(gear) {
    engine.gear = gear;
    engine.shiftTimer = profile.shiftDurationS;
  }

  // Requested manual shift (+1/-1), applied once the gearbox is free.
  let pendingShift = 0;

  /** Queues a manual up (+1) or down (-1) shift. */
  function requestShift(step) {
    pendingShift = Math.sign(step);
  }

  /**
   * Advances rpm/gearbox by `dt` and returns the drive force (N, unsigned).
   * direction: 1 forward, -1 reverse, 0 coasting/braking (rpm still tracks).
   * throttle: 0..1. wheelSpeedAbs: unsigned driven-wheel tread speed (m/s),
   * so wheelspin and airborne throttle rev the engine. groundSpeedAbs:
   * unsigned chassis speed (m/s), picks the upshift point. grounded: no
   * upshifts while the driven wheels are in the air. slipping: driven wheels
   * sliding: on throttle it drops gears to keep rpm high, else it holds.
   * mode: 'sport' (late shifts, slide downshifts) or 'comfort' (early shifts).
   */
  function update(dt, { direction, throttle, wheelSpeedAbs, groundSpeedAbs = wheelSpeedAbs, grounded = true, slipping = false, mode = 'sport' }) {
    if (engine.shiftTimer > 0) engine.shiftTimer = Math.max(0, engine.shiftTimer - dt);
    if (engine.manualHoldTimer > 0) engine.manualHoldTimer = Math.max(0, engine.manualHoldTimer - dt);

    // Engage the gear for the requested direction; forward restarts in 1st.
    if (direction === -1 && engine.gear !== 0) {
      shiftTo(0);
    } else if (direction === 1 && engine.gear === 0) {
      shiftTo(1);
    }

    const wheelAngularSpeed = Math.max(0, wheelSpeedAbs) / wheelRadius; // rad/s
    const groundAngularSpeed = Math.max(0, groundSpeedAbs) / wheelRadius;

    // Manual shift (forward gears only); a downshift that would over-rev is refused.
    if (pendingShift !== 0 && engine.shiftTimer <= 0) {
      const target = engine.gear + pendingShift;
      if (engine.gear >= 1 && target >= 1 && target <= engine.gearCount) {
        const targetRatio = profile.gearRatios[target - 1];
        const targetRpm = Math.max(toRpm(wheelAngularSpeed, targetRatio), toRpm(groundAngularSpeed, targetRatio));
        if (pendingShift > 0 || targetRpm < profile.redlineRpm) {
          shiftTo(target);
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
    if (engine.gear >= 1 && engine.shiftTimer <= 0 && engine.manualHoldTimer <= 0 && grounded) {
      const groundRpm = toRpm(groundAngularSpeed, ratio);
      const upshiftRpm = Math.min(engine.rpm, groundRpm);
      const shift = mode === 'comfort' ? comfortShift(upshiftRpm, groundRpm, wheelAngularSpeed, ratio) : sportShift(upshiftRpm, groundRpm, wheelAngularSpeed, ratio, direction, throttle, slipping);
      if (shift !== 0) shiftTo(engine.gear + shift);
    }

    // Gear may have changed above.
    const totalRatio = Math.abs(ratioForGear(engine.gear)) * profile.finalDriveRatio;
    const inTorqueCut = engine.shiftTimer > profile.shiftDurationS * (1 - SHIFT_TORQUE_CUT_FRACTION);
    const clampedThrottle = direction === 0 ? 0 : Math.max(0, throttle);
    // Torque from the unsmoothed wheel rpm, so the limiter bites immediately;
    // while the clutch slips at pull-away, from the revving engine instead.
    const torqueRpm = launching ? Math.max(wheelRpm, engine.rpm) : wheelRpm;
    const engineTorqueNm = inTorqueCut ? 0 : torqueAtRpm(torqueRpm, profile) * clampedThrottle;
    const torqueToForce = (totalRatio * DRIVETRAIN_EFFICIENCY * DRIVETRAIN_EFFICIENCY_MODIFIER) / wheelRadius;
    const totalDrivetrainForce = engineTorqueNm * torqueToForce;

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
  return engine;
}
