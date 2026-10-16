import { STEER_SPEED, MAX_STEER, BRAKE_FORCE, TURBO_MULT, HANDBRAKE_LATCH_S } from '../config.js';

// Keyboard -> vehicle controls, applied each frame.

/** Wheeled rigs spread the input over every steered wheel; hover rigs take it as is. */
function steer(vehicle, value, speedKmh) {
  if (vehicle.applySteer) vehicle.applySteer(value, speedKmh);
  else vehicle.setSteeringValue(value, 0);
}

function isTypingInField() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && el.type !== 'range' && el.type !== 'color';
}

/** @param {{ onHandbrakeLatch?: () => void, initialHandbrakeLatched?: boolean }} [options] */
export function createInputController({ onHandbrakeLatch, initialHandbrakeLatched = false } = {}) {
  const keys = new Set();
  // Ignore keydown while typing in a field; keyup always runs so keys don't stick.

  // For gradual, not instant steering
  let steerValue = 0;
  // Throttle pedal 0..1, read by the engine sound.
  let throttle = 0;

  window.addEventListener('keydown', (e) => {
    if (isTypingInField()) return;
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  // Edge-triggered: R starts one reset animation per press.
  let resetWasPressed = false;
  // Backward pressed while moving forward only brakes, until released - reversing
  // needs a fresh press. Forward has no latch: it brakes, then drives forward.
  let backwardWasPressed = false;
  let backwardBrakeOnly = false;
  // Held for HANDBRAKE_LATCH_S it stays pulled; the next press only releases it.
  let handbrakeWasPressed = false;
  let handbrakeHeldS = 0;
  let handbrakeLatched = initialHandbrakeLatched;
  let handbrakeReleasing = false;
  let handbrakeOn = initialHandbrakeLatched;

  /**
   * Applies key state to the vehicle (engine, steering, brake, R reset).
   * Zeroes controls while typing. `dt` drives the engine.js gearbox, if any.
   */
  function updateControls(vehicle, reset, dt = 0) {
    throttle = 0;
    if (!vehicle) return;
    // Driven wheels; default RWD (hover rigs ignore the index).
    const driveWheels = vehicle.driveWheels ?? [2, 3];
    if (isTypingInField()) {
      for (const i of driveWheels) vehicle.applyEngineForce(0, i);
      steer(vehicle, 0, 0);
      vehicle.airControlYaw = 0;
      return;
    }
    const forward = keys.has('KeyW') || keys.has('ArrowUp');
    const backward = keys.has('KeyS') || keys.has('ArrowDown');
    const left = keys.has('KeyA') || keys.has('ArrowLeft');
    const right = keys.has('KeyD') || keys.has('ArrowRight');
    const handbrakePressed = keys.has('Space');
    const turbo = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const forceScale = turbo ? TURBO_MULT : 1;

    // Flat fallback force; hover rigs use it only as a ±1 throttle sign,
    // wheeled cars use vehicle.engine (below) instead.
    const engineForceUnit = vehicle.engineForce ?? 1;
    // Hover rigs have no forward speed; 0 means always "stopped".
    const forwardSpeed = vehicle.getForwardSpeed?.() ?? 0;
    // Below this (m/s) the car counts as stopped.
    const STOP_SPEED = 0.5;
    const movingForward = forwardSpeed > STOP_SPEED;
    const movingBackward = forwardSpeed < -STOP_SPEED;
    if (backward && !backwardWasPressed && movingForward) backwardBrakeOnly = true;
    if (!backward) backwardBrakeOnly = false;
    backwardWasPressed = backward;
    // Opposite key while still moving = brake (at brakeForce), not reverse thrust.
    const pedalBraking =
      (forward && movingBackward) || (backward && (movingForward || backwardBrakeOnly));
    // Gearbox force for wheeled cars. direction 0 while pedal-braking (no
    // premature reverse) but rpm/gear still track wheel speed for the HUD.
    const engineMagnitude = vehicle.engine
      ? vehicle.engine.update(dt, {
          direction: pedalBraking ? 0 : forward ? 1 : backward ? -1 : 0,
          throttle: pedalBraking || !(forward || backward) ? 0 : 1,
          wheelSpeedAbs: Math.abs(vehicle.getDriveWheelSpeed?.() ?? forwardSpeed),
          grounded: driveWheels.some((i) => vehicle.wheelInfos[i]?.isInContact),
        })
      : engineForceUnit;
    if (vehicle.engine && vehicle.setDriveline) {
      const { reflectedMass, limitWheelSpeed, engineBrakeForce } = vehicle.engine;
      for (const i of driveWheels) {
        vehicle.setDriveline(i, {
          mass: reflectedMass / driveWheels.length,
          speedLimit: limitWheelSpeed,
          engineBrake: engineBrakeForce / driveWheels.length,
        });
      }
    }

    throttle = forward ? 1 : 0;

    const engineForce = pedalBraking
      ? 0
      : (forward ? -engineMagnitude : backward ? engineMagnitude : 0) * forceScale;
    // engine force is a per-wheel value at the 2-wheel baseline; scale so
    // total force is the same whatever the number of driven wheels.
    const perWheelEngineForce = engineForce * (2 / driveWheels.length);
    for (const i of driveWheels) vehicle.applyEngineForce(perWheelEngineForce, i);

    // Speed-sensitive steering lock between maxSteerAt0 and maxSteerAt100
    // (100 km/h+), by unsigned speed.
    const speedKmh = Math.abs(forwardSpeed) * 3.6;
    const steerSpeedT = Math.min(speedKmh / 100, 1);
    const steerReturnSpeed = vehicle.steerSpeedD * 4 ?? STEER_SPEED * 4;
    const maxSteerAt0 = vehicle.maxSteerAt0 ?? MAX_STEER;
    const maxSteerAt100 = vehicle.maxSteerAt100 ?? MAX_STEER;
    const effectiveMaxSteer = maxSteerAt0 + (maxSteerAt100 - maxSteerAt0) * steerSpeedT;

    if (vehicle.vehicleType === 'hover') {
      steerValue = left ? effectiveMaxSteer : right ? -effectiveMaxSteer : 0;
    } else {
      const steerSpeedD = vehicle.steerSpeedD ?? STEER_SPEED;
      const targetSteer = left ? effectiveMaxSteer : right ? -effectiveMaxSteer : 0;

      const directionChanged =
          steerValue !== 0 &&
          targetSteer !== 0 &&
          Math.sign(steerValue) !== Math.sign(targetSteer);

      const speed = directionChanged
          ? steerReturnSpeed
          : (left || right) ? steerSpeedD : steerReturnSpeed;

      const delta = targetSteer - steerValue;
      const maxStep = speed * dt * 120;
      steerValue += Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
    }

    steer(vehicle, steerValue, speedKmh);

    vehicle.airControlYaw = left ? 1 : right ? -1 : 0;

    if (handbrakePressed && !handbrakeWasPressed && handbrakeLatched) {
      handbrakeLatched = false;
      handbrakeReleasing = true;
    }
    if (!handbrakePressed) handbrakeReleasing = false;
    handbrakeWasPressed = handbrakePressed;
    const handbrakeHeld = handbrakePressed && !handbrakeReleasing;
    handbrakeHeldS = handbrakeHeld ? handbrakeHeldS + dt : 0;
    if (handbrakeHeld && !handbrakeLatched && handbrakeHeldS >= HANDBRAKE_LATCH_S) {
      handbrakeLatched = true;
      onHandbrakeLatch?.();
    }
    const handbrake = handbrakeHeld || handbrakeLatched;
    handbrakeOn = handbrake;

    // Per-vehicle brake strength; BRAKE_FORCE fallback.
    const brakeForce = (vehicle.brakeForce ?? BRAKE_FORCE) * forceScale;
    const pedalBrake = pedalBraking ? brakeForce : 0;
    // Handbrake locks only the rear (handbrake-axle) wheels, so the rear breaks traction.
    const handbrakeForce = handbrake ? brakeForce : 0;
    // ABS only on the pedal brake; the handbrake must be able to lock.
    const abs = vehicle.abs ?? false;
    if (vehicle.applyBrakes) {
      vehicle.applyBrakes(pedalBrake, handbrakeForce, abs);
    } else {
      setFourBrakes(vehicle, pedalBrake, handbrakeForce, handbrake, abs);
    }

    const resetPressed = keys.has('KeyR');
    if (resetPressed && !resetWasPressed && reset) reset();
    resetWasPressed = resetPressed;
  }

  /** Brakes for rigs without applyBrakes (hover): front pair pedal only, rear pair + handbrake. */
  function setFourBrakes(vehicle, pedalBrake, handbrakeForce, handbrake, abs) {
    vehicle.setBrake(pedalBrake, 0, abs);
    vehicle.setBrake(pedalBrake, 1, abs);
    vehicle.setBrake(Math.max(pedalBrake, handbrakeForce), 2, abs && !handbrake, handbrake);
    vehicle.setBrake(Math.max(pedalBrake, handbrakeForce), 3, abs && !handbrake, handbrake);
  }

  function isTyping() {
    return isTypingInField();
  }

  return {
    keys,
    updateControls,
    isTyping,
    getThrottle: () => throttle,
    getHandbrake: () => ({ on: handbrakeOn, latched: handbrakeLatched }),
  };
}
