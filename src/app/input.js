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
   * vehicle yet.
   */
  function updateControls(vehicle, reset) {
    if (!vehicle) return;
    if (isTypingInField()) {
      vehicle.applyEngineForce(0, 2);
      vehicle.applyEngineForce(0, 3);
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
    //  - wheeled cars (lib/car.js's createCar) derive it from
    //    descriptor.enginePowerHp - an equivalent-bhp rating, so e.g. a
    //    monster truck can be tuned dramatically more powerful than the
    //    baseline rally car just by giving it a bigger hp number.
    //  - hover chariots (lib/chariot.js's createChariotVehicle) don't use
    //    this for their actual thrust at all (see
    //    descriptor.engineThrustForce - thrust of one engine) - they leave
    //    this at its default of 1 and only use it as a +-1 throttle sign.
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
    const engineForce = pedalBraking
      ? 0
      : (forward ? -engineForceUnit : backward ? engineForceUnit : 0) * forceScale;
    // rear-wheel drive (indices 2, 3)
    vehicle.applyEngineForce(engineForce, 2);
    vehicle.applyEngineForce(engineForce, 3);

    const steerValue = left ? MAX_STEER : right ? -MAX_STEER : 0;
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
