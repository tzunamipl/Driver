// Combustion-engine + gearbox simulation for wheeled cars, replacing the
// old flat "apply a constant force regardless of speed" arcade model (see
// lib/car.js's now-removed hpToEngineForce) with an actual rpm-driven
// torque curve routed through a multi-speed gearbox + final drive - so how
// much force reaches the wheels now depends on which gear the car is in
// and how hard the engine is spinning, the same way a real car's does,
// instead of being one flat number from a dead stop to top speed.
// Self-contained (no cannon-es/THREE imports) so it can be unit-tested/
// tuned independently of the physics rig - lib/car.js only ever reads
// createEngineState()'s return value and calls .update() once a frame via
// app/input.js.
//
// Deliberately only wired up for wheeled vehicles (lib/car.js's createCar)
// - hover rigs (lib/chariot.js) have no engine/gearbox of their own and
// never call into this module.

// Gearbox/clutch energy losses - a real manual gearbox + open differential
// typically loses ~8-12% of engine torque before it reaches the tyres.
const DRIVETRAIN_EFFICIENCY = 0.9;
// How fast the simulated rpm needle chases the value implied by current
// wheel speed/gear (simulated flywheel inertia), in "fraction of the gap
// closed per second" - high enough to feel responsive, low enough that a
// sudden gearshift/clutch-in reads as a brief flare/dip instead of an
// instant rpm teleport.
const RPM_RESPONSE_PER_S = 10;
// Auto-shift points, as a fraction of redlineRpm. Upshifts just shy of the
// rev limiter; downshifts only once rpm has dropped far enough that the
// *next lower* gear wouldn't itself immediately bounce off redline (see
// the lowerRpm check in update() below).
const UPSHIFT_RPM_FRACTION = 0.95;
const DOWNSHIFT_RPM_FRACTION = 0.4;
// Total gear-change duration (seconds) and the leading fraction of it
// spent with the clutch open (zero drive torque) - a brief, felt
// interruption in power delivery each shift, instead of gears swapping
// with no transition at all.
const SHIFT_DURATION_S = 0.35;
const SHIFT_TORQUE_CUT_FRACTION = 0.6;

const RAD_S_TO_RPM = 60 / (2 * Math.PI);

// Baseline rally-car engine/gearbox numbers, used for any descriptor field
// left unset - independent per-vehicle overrides (descriptor.peakTorqueNm,
// descriptor.gearRatios, etc. - see lib/vehicles/gc8.js/bigfoot.js) follow
// the same "falls back to one shared default" pattern as
// enginePowerHp/mass/wheelRadius already do in lib/car.js.
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
 * Naturally-aspirated-shaped torque curve: climbs from a soft ~60% of
 * peak at idle, up to 100% at peakTorqueRpm, then tapers back down to
 * ~65% by redline - then a rev limiter chops it hard just past redline
 * (a real engine's ignition cut, not a gentle fade). Simple enough to
 * tune with just 4 numbers per vehicle instead of needing a full lookup
 * table, while still giving each gear a rise-then-fall power band rather
 * than a flat line.
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

/**
 * Creates the mutable engine/gearbox state for one wheeled vehicle, read
 * generically from its descriptor (see lib/vehicles/gc8.js/bigfoot.js) the
 * same way mass/enginePowerHp/wheelRadius already are - any field left
 * unset falls back to DEFAULT_ENGINE_PROFILE's baseline rally-car numbers.
 * `wheelRadius` is passed separately since lib/car.js already resolves it
 * (descriptor.wheelRadius ?? WHEEL_RADIUS) for the physics wheels - no
 * need to re-resolve it here.
 */
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
  };

  const engine = {
    // Read by hud/gauges.js's tachometer/gear indicator each frame.
    rpm: profile.idleRpm,
    gear: 1, // 1..gearRatios.length = forward gears, 0 = reverse
    gearCount: profile.gearRatios.length,
    idleRpm: profile.idleRpm,
    redlineRpm: profile.redlineRpm,
    shiftTimer: 0,
    get gearLabel() {
      return engine.gear === 0 ? 'R' : String(engine.gear);
    },
  };

  function ratioForGear(gear) {
    return gear === 0 ? profile.reverseRatio : profile.gearRatios[gear - 1];
  }

  /**
   * Advances the simulated rpm/gearbox state by `dt` seconds and returns
   * the drivetrain's resulting force rating (Newtons, unsigned) - app/
   * input.js applies this exactly like the old flat engineForceUnit (same
   * +-sign/direction handling, same per-driven-wheel split), just computed
   * from the torque curve/current gear instead of being one constant.
   *
   * `direction`: 1 = driver wants to go forward, -1 = reverse, 0 =
   *   coasting/braking (no drive torque demanded, but the gearbox/rpm
   *   keep tracking wheel speed rather than freezing).
   * `throttle`: 0..1 (keyboard input is all-or-nothing today, but this
   *   stays ready for analog input).
   * `forwardSpeedAbs`: current unsigned chassis speed (m/s) along its
   *   forward axis - stands in for wheel rotation speed assuming no slip
   *   (good enough for picking an rpm/gear; the actual tyre force/grip
   *   split still happens in lib/wheeledVehicle.js same as before).
   */
  function update(dt, { direction, throttle, forwardSpeedAbs }) {
    if (engine.shiftTimer > 0) engine.shiftTimer = Math.max(0, engine.shiftTimer - dt);

    // Engage the gear matching the driver's intended direction. Forward
    // always (re)starts from 1st rather than resuming whatever gear it
    // last left off in - matches a real manual needing to be reselected
    // after coming to a stop to change direction (app/input.js only ever
    // asks for direction=-1 once the car's actually stopped/reversing -
    // see its pedalBraking/brake-only-latch handling).
    if (direction === -1 && engine.gear !== 0) {
      engine.gear = 0;
      engine.shiftTimer = profile.shiftDurationS;
    } else if (direction === 1 && engine.gear === 0) {
      engine.gear = 1;
      engine.shiftTimer = profile.shiftDurationS;
    }

    const wheelAngularSpeed = Math.max(0, forwardSpeedAbs) / wheelRadius; // rad/s
    const ratio = Math.abs(ratioForGear(engine.gear));
    const targetRpm = Math.max(
      profile.idleRpm,
      wheelAngularSpeed * ratio * profile.finalDriveRatio * RAD_S_TO_RPM
    );
    const smoothing = Math.min(1, dt * RPM_RESPONSE_PER_S);
    engine.rpm += (targetRpm - engine.rpm) * smoothing;
    engine.rpm = Math.min(engine.rpm, profile.redlineRpm * 1.02);

    // Automatic up/downshifts - forward gears only (reverse has nothing
    // to shift between). Held off while a shift's already in progress so
    // one fully completes before the next can start.
    if (engine.gear >= 1 && engine.shiftTimer <= 0) {
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

    const inTorqueCut = engine.shiftTimer > profile.shiftDurationS * (1 - SHIFT_TORQUE_CUT_FRACTION);
    const clampedThrottle = direction === 0 ? 0 : Math.max(0, throttle);
    const engineTorqueNm = inTorqueCut ? 0 : torqueAtRpm(engine.rpm, profile) * clampedThrottle;
    const totalDrivetrainForce =
      (engineTorqueNm * ratio * profile.finalDriveRatio * DRIVETRAIN_EFFICIENCY) / wheelRadius;

    // Halved before returning: app/input.js's per-wheel split
    // (perWheelEngineForce = engineForce * 2/driveWheels.length) assumes
    // this value is a *per-driven-wheel-at-the-2-wheel-drive-baseline*
    // unit (exactly like the old flat engineForceUnit was), not the total
    // force already summed across every driven wheel - multiplying back
    // out by driveWheels.length there recovers totalDrivetrainForce
    // regardless of how many wheels actually share it.
    return totalDrivetrainForce / 2;
  }

  engine.update = update;
  return engine;
}
