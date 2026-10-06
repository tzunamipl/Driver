import { MAX_STEER, BRAKE_FORCE, TURBO_MULT } from '../config.js';

// Keyboard input: reads raw key state and translates it into vehicle
// control calls each frame. Isolated from the main loop so control
// scheme/tuning (key bindings, force curves) can change independently of
// physics stepping and rendering.

function isTypingInField() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && el.type !== 'range' && el.type !== 'color';
}

export function createInputController() {
  const keys = new Set();
  // Ignore keydowns while a text field (e.g. the address search box) is
  // focused, so typing there never reaches game controls. keyup always
  // runs so a key released after the field loses focus doesn't get stuck.
  window.addEventListener('keydown', (e) => {
    if (isTypingInField()) return;
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  // Edge-triggered: reset() now animates the lift over time, so holding R
  // down must fire it once, not restart the animation every frame.
  let resetWasPressed = false;
  // "Brake-only" latches: once pressing the opposite-direction key brakes
  // a still-moving car, keep braking (never fall through to reverse/
  // forward thrust) for as long as that key stays held, even after the
  // car has fully stopped. The latch only clears on key release, so the
  // driver must lift the key and press it again to actually engage
  // reverse/forward - holding it through the stop no longer auto-reverses.
  let backwardWasPressed = false;
  let forwardWasPressed = false;
  let backwardBrakeOnly = false;
  let forwardBrakeOnly = false;

  /**
   * Applies current key state to the vehicle's engine/steering/brake, and
   * triggers a car reset on "R". No-ops (and zeroes controls) while the
   * user is typing into a text input, and no-ops entirely if there's no
   * vehicle yet. `dt` (seconds) drives the per-vehicle rpm/gearbox
   * simulation (lib/engine.js's vehicle.engine.update) - unused by rigs
   * without one (e.g. the hover chariot).
   */
  function updateControls(vehicle, reset, dt = 0) {
    if (!vehicle) return;
    // Which wheels get engine force (see lib/car.js's driveWheels doc
    // comment) - defaults to rear-wheel drive for rigs that don't set one
    // (e.g. the hover chariot, which ignores the wheel index argument
    // entirely anyway).
    const driveWheels = vehicle.driveWheels ?? [2, 3];
    if (isTypingInField()) {
      for (const i of driveWheels) vehicle.applyEngineForce(0, i);
      vehicle.setSteeringValue(0, 0);
      vehicle.setSteeringValue(0, 1);
      vehicle.airControlYaw = 0;
      return;
    }
    const forward = keys.has('KeyW') || keys.has('ArrowUp');
    const backward = keys.has('KeyS') || keys.has('ArrowDown');
    const left = keys.has('KeyA') || keys.has('ArrowLeft');
    const right = keys.has('KeyD') || keys.has('ArrowRight');
    const handbrake = keys.has('Space');
    const turbo = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const forceScale = turbo ? TURBO_MULT : 1;

    // vehicle.engineForce is each vehicle's own independent power
    // characteristic, set per-rig from its descriptor (not from any shared
    // global constant):
    //  - hover chariots (lib/chariot.js's createChariotVehicle) don't use
    //    this for their actual thrust at all (see
    //    descriptor.engineThrustForce - thrust of one engine) - they leave
    //    this at its default of 1 and only use it as a +-1 throttle sign.
    //  - wheeled cars (lib/car.js's createCar) instead carry a
    //    vehicle.engine (lib/engine.js's rpm/gearbox simulation, below) -
    //    engineForceUnit is only this fallback flat value for rigs that
    //    don't have one.
    const engineForceUnit = vehicle.engineForce ?? 1;
    // Signed forward speed (vehicle.getForwardSpeed, see lib/car.js) is
    // undefined for rigs without the wheeled RaycastVehicle-style forward
    // axis (e.g. the hover chariot); `?? 0` there just means those rigs
    // always take the "already stopped" branch below, i.e. keep their old
    // always-reverse-thrust behavior unchanged.
    const forwardSpeed = vehicle.getForwardSpeed?.() ?? 0;
    // Below this (m/s) we treat the car as "stopped" rather than still
    // coasting, so a light residual drift doesn't get stuck permanently
    // braking instead of ever engaging reverse/forward thrust.
    const STOP_SPEED = 0.5;
    const movingForward = forwardSpeed > STOP_SPEED;
    const movingBackward = forwardSpeed < -STOP_SPEED;
    // Arm the brake-only latch the moment the opposite-direction key is
    // pressed into a still-moving car; release it as soon as the key is
    // let go. While armed, the key keeps braking even after the car drops
    // below STOP_SPEED, so reverse/forward thrust only kicks in once the
    // driver lifts the key and presses it again (with the car already
    // stopped/no longer coasting the other way).
    if (backward && !backwardWasPressed && movingForward) backwardBrakeOnly = true;
    if (!backward) backwardBrakeOnly = false;
    if (forward && !forwardWasPressed && movingBackward) forwardBrakeOnly = true;
    if (!forward) forwardBrakeOnly = false;
    backwardWasPressed = backward;
    forwardWasPressed = forward;
    // Pressing the "wrong way" key while still coasting the other way now
    // actually brakes (at the vehicle's own stronger brakeForce) instead
    // of just fighting the current momentum with an equal and opposite
    // engine force (which took as long to stop as it did to speed up) -
    // only once the car has actually slowed/stopped AND the key has been
    // released and pressed again does the key switch to applying
    // reverse/forward thrust.
    const pedalBraking =
      (forward && (movingBackward || forwardBrakeOnly)) ||
      (backward && (movingForward || backwardBrakeOnly));
    // Dynamic (rpm/gear-dependent) force rating for wheeled cars (see
    // lib/engine.js) instead of a flat engineForceUnit - direction=0 while
    // pedal-braking keeps the gearbox from prematurely engaging reverse
    // mid-stop (reverse is only ever requested once the car's actually
    // stopped/reversing, same as before), but still advances rpm/gear
    // state every frame so the tachometer/gear indicator (hud/gauges.js)
    // keep tracking wheel speed while coasting/braking instead of
    // freezing. Rigs without a gearbox (vehicle.engine undefined, e.g. the
    // hover chariot) keep the old flat engineForceUnit unchanged.
    const engineMagnitude = vehicle.engine
      ? vehicle.engine.update(dt, {
          direction: pedalBraking ? 0 : forward ? 1 : backward ? -1 : 0,
          throttle: pedalBraking || !(forward || backward) ? 0 : 1,
          forwardSpeedAbs: Math.abs(forwardSpeed),
        })
      : engineForceUnit;
    const engineForce = pedalBraking
      ? 0
      : (forward ? -engineMagnitude : backward ? engineMagnitude : 0) * forceScale;
    // Spread engineForce across however many wheels this vehicle drives
    // (lib/car.js's driveWheels, defaulting to rear-wheel drive), scaled
    // so the *total* propulsive force stays the same as the original
    // rear-wheel-drive-only tuning (FORCE_PER_HP in lib/car.js assumed
    // exactly 2 driven wheels each getting the full engineForce value) -
    // 2 driven wheels still gets the full value per wheel (unchanged from
    // before this option existed), while e.g. 4-wheel drive gets half each,
    // for the same total force split across twice as many contact patches.
    const perWheelEngineForce = engineForce * (2 / driveWheels.length);
    for (const i of driveWheels) vehicle.applyEngineForce(perWheelEngineForce, i);

    // Speed-sensitive steering lock: lerp between the vehicle's own
    // maxSteerAt0 (dead stop) and maxSteerAt100 (100 km/h and up) ratings
    // (see lib/car.js/lib/vehicles/*.js), by how fast it's actually going
    // right now - `?? MAX_STEER` on both ends keeps any rig that doesn't
    // set these (e.g. the hover chariot) on today's flat, speed-
    // independent lock. Uses the unsigned speed so reversing fast also
    // tapers the lock, not just driving forward fast.
    const speedKmh = Math.abs(forwardSpeed) * 3.6;
    const steerSpeedT = Math.min(speedKmh / 100, 1);
    const maxSteerAt0 = vehicle.maxSteerAt0 ?? MAX_STEER;
    const maxSteerAt100 = vehicle.maxSteerAt100 ?? MAX_STEER;
    const effectiveMaxSteer = maxSteerAt0 + (maxSteerAt100 - maxSteerAt0) * steerSpeedT;

    const steerValue = left ? effectiveMaxSteer : right ? -effectiveMaxSteer : 0;
    vehicle.setSteeringValue(steerValue, 0);
    vehicle.setSteeringValue(steerValue, 1);
    vehicle.airControlYaw = left ? 1 : right ? -1 : 0;

    // vehicle.brakeForce is each vehicle's own independent brake strength
    // (see lib/car.js's createCar), set per-rig from its descriptor the
    // same way engineForce is above - BRAKE_FORCE is only a fallback for
    // rigs that don't set one (e.g. the hover chariot, which only treats
    // this as a +0 boolean, not an actual force).
    const brakeForce = (vehicle.brakeForce ?? BRAKE_FORCE) * forceScale;
    const pedalBrake = pedalBraking ? brakeForce : 0;
    // Handbrake (Space) now only brakes the rear wheels (indices 2, 3),
    // not all four - locking just the rear tyres' grip while the fronts
    // keep steering grip is what actually breaks rear traction into a
    // slide/oversteer, instead of just locking all 4 wheels into a
    // straight, grippy stop like a regular brake.
    const handbrakeForce = handbrake ? brakeForce : 0;
    vehicle.setBrake(pedalBrake, 0);
    vehicle.setBrake(pedalBrake, 1);
    vehicle.setBrake(Math.max(pedalBrake, handbrakeForce), 2);
    vehicle.setBrake(Math.max(pedalBrake, handbrakeForce), 3);

    const resetPressed = keys.has('KeyR');
    if (resetPressed && !resetWasPressed && reset) reset();
    resetWasPressed = resetPressed;
  }

  function isTyping() {
    return isTypingInField();
  }

  return { keys, updateControls, isTyping };
}
