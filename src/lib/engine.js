// Engine + gearbox for wheeled cars: rpm-dependent torque curve through
// gear ratios and final drive, with automatic shifting. Pure math (no
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
// Auto-shift points as fractions of redline (downshift only if the lower
// gear wouldn't hit redline).
const UPSHIFT_RPM_FRACTION = 0.95;
const DOWNSHIFT_RPM_FRACTION = 0.4;
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

  /**
   * Advances rpm/gearbox by `dt` and returns the drive force (N, unsigned).
   * direction: 1 forward, -1 reverse, 0 coasting/braking (rpm still tracks).
   * throttle: 0..1. wheelSpeedAbs: unsigned driven-wheel tread speed (m/s),
   * so wheelspin and airborne throttle rev the engine. grounded: no
   * upshifts while the driven wheels are in the air.
   */
  function update(dt, { direction, throttle, wheelSpeedAbs, grounded = true }) {
    if (engine.shiftTimer > 0) engine.shiftTimer = Math.max(0, engine.shiftTimer - dt);

    // Engage the gear for the requested direction; forward restarts in 1st.
    if (direction === -1 && engine.gear !== 0) {
      engine.gear = 0;
      engine.shiftTimer = profile.shiftDurationS;
    } else if (direction === 1 && engine.gear === 0) {
      engine.gear = 1;
      engine.shiftTimer = profile.shiftDurationS;
    }

    const wheelAngularSpeed = Math.max(0, wheelSpeedAbs) / wheelRadius; // rad/s
    const ratio = Math.abs(ratioForGear(engine.gear));
    // Below idle the clutch slips, so the engine never stalls.
    const wheelRpm = Math.max(profile.idleRpm, wheelAngularSpeed * ratio * profile.finalDriveRatio * RAD_S_TO_RPM);
    const smoothing = Math.min(1, dt * RPM_RESPONSE_PER_S);
    engine.rpm += (wheelRpm - engine.rpm) * smoothing;
    engine.rpm = Math.min(engine.rpm, profile.redlineRpm * 1.02);

    // Auto-shift (forward only, on the ground), one shift at a time.
    if (engine.gear >= 1 && engine.shiftTimer <= 0 && grounded) {
      if (engine.rpm > profile.redlineRpm * UPSHIFT_RPM_FRACTION && engine.gear < engine.gearCount) {
        engine.gear++;
        engine.shiftTimer = profile.shiftDurationS;
      } else if (engine.gear > 1) {
        const lowerRatio = Math.abs(profile.gearRatios[engine.gear - 2]);
        const lowerRpm = wheelAngularSpeed * lowerRatio * profile.finalDriveRatio * RAD_S_TO_RPM;
        if (
          engine.rpm < profile.redlineRpm * DOWNSHIFT_RPM_FRACTION &&
          lowerRpm < profile.redlineRpm * UPSHIFT_RPM_FRACTION
        ) {
          engine.gear--;
          engine.shiftTimer = profile.shiftDurationS;
        }
      }
    }

    // Gear may have changed above.
    const totalRatio = Math.abs(ratioForGear(engine.gear)) * profile.finalDriveRatio;
    const inTorqueCut = engine.shiftTimer > profile.shiftDurationS * (1 - SHIFT_TORQUE_CUT_FRACTION);
    const clampedThrottle = direction === 0 ? 0 : Math.max(0, throttle);
    // Torque from the unsmoothed wheel rpm, so the limiter bites immediately.
    const engineTorqueNm = inTorqueCut ? 0 : torqueAtRpm(wheelRpm, profile) * clampedThrottle;
    const torqueToForce = (totalRatio * DRIVETRAIN_EFFICIENCY * DRIVETRAIN_EFFICIENCY_MODIFIER) / wheelRadius;
    const totalDrivetrainForce = engineTorqueNm * torqueToForce;

    const rpmFraction = Math.max(0, (wheelRpm - profile.idleRpm) / (profile.redlineRpm - profile.idleRpm));
    const brakeTorqueNm = clampedThrottle > 0 ? 0 : profile.peakTorqueNm * ENGINE_BRAKE_FRACTION * Math.min(1, rpmFraction);
    engine.reflectedMass = inTorqueCut ? 0 : (profile.engineInertia * totalRatio * totalRatio) / (wheelRadius * wheelRadius);
    engine.limitWheelSpeed = inTorqueCut ? Infinity : ((profile.redlineRpm / RAD_S_TO_RPM) / totalRatio) * wheelRadius;
    engine.engineBrakeForce = inTorqueCut ? 0 : brakeTorqueNm * torqueToForce;

    // Halved: input.js treats this as a per-wheel value at the 2-wheel
    // baseline and multiplies back by the driven-wheel count.
    return totalDrivetrainForce / 2;
  }

  engine.update = update;
  return engine;
}
