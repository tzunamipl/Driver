import { STEER_SPEED, MAX_STEER, BRAKE_FORCE, BRAKE_RAMP_S, TURBO_MULT, IS_DEV_MODE, HANDBRAKE_LATCH_S, GEAR_MODE_STORAGE_KEY, TRANSMISSION_STORAGE_KEY } from '../config.js';
import { GEAR_MODES } from '../lib/engine.js';

// Keyboard -> vehicle controls, applied each frame.

/** Wheeled rigs spread the input over every steered wheel; hover rigs take it as is. */
function steer(vehicle, value, speedKmh) {
  if (vehicle.applySteer) vehicle.applySteer(value, speedKmh);
  else vehicle.setSteeringValue(value, 0);
}

const TRANSMISSIONS = ['auto', 'manual'];

function loadChoice(key, choices) {
  try {
    const saved = localStorage.getItem(key);
    return choices.includes(saved) ? saved : choices[0];
  } catch {
    return choices[0];
  }
}

function saveChoice(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable - choice just resets next session.
  }
}

function isTypingInField() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && el.type !== 'range' && el.type !== 'color';
}

const SPACE_ACTIVATED_INPUTS = ['button', 'submit', 'reset', 'checkbox', 'radio'];

function isSpaceActivated(el) {
  if (!el) return false;
  if (el.tagName === 'BUTTON' || el.tagName === 'SELECT' || el.tagName === 'SUMMARY') return true;
  return el.tagName === 'INPUT' && SPACE_ACTIVATED_INPUTS.includes(el.type);
}

/**
 * @param {{ onHandbrakeLatch?: () => void, initialHandbrakeLatched?: boolean,
 *   holdLatchesHandbrake?: () => boolean, onGearEvent?: (type: string, engine: object) => void }} [options]
 */
export function createInputController({ onHandbrakeLatch, initialHandbrakeLatched = false, holdLatchesHandbrake = () => true, onGearEvent } = {}) {
  const keys = new Set();
  const noKeys = new Set();
  // Locked (a menu over the game): the car gets no keys, as if nothing were pressed.
  let locked = false;
  // Ignore keydown while typing in a field; keyup always runs so keys don't stick.

  // For gradual, not instant steering
  let steerValue = 0;
  // Throttle pedal 0..1, read by the engine sound.
  let throttle = 0;
  // Brake pedal 0..1: ramps up while braking, releases at once.
  let brakePedal = 0;

  window.addEventListener('keydown', (e) => {
    // Space is the handbrake: drop focus from a clicked button/checkbox so the key can't re-press it.
    if (e.code === 'Space' && isSpaceActivated(document.activeElement)) {
      e.preventDefault();
      document.activeElement.blur();
    }
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
  let gearMode = loadChoice(GEAR_MODE_STORAGE_KEY, GEAR_MODES);
  let transmission = loadChoice(TRANSMISSION_STORAGE_KEY, TRANSMISSIONS);
  // Edge-triggered manual shifts: E up, Q down.
  let shiftUpWasPressed = false;
  let shiftDownWasPressed = false;

  /**
   * Applies key state to the vehicle (engine, steering, brake, R reset).
   * Zeroes controls while typing. `dt` drives the engine.js gearbox, if any.
   */
  function updateControls(vehicle, reset, dt = 0) {
    throttle = 0;
    if (!vehicle) return;
    const held = locked ? noKeys : keys;
    // Driven wheels; default RWD (hover rigs ignore the index).
    const driveWheels = vehicle.driveWheels ?? [2, 3];
    if (isTypingInField()) {
      brakePedal = 0;
      for (const i of driveWheels) vehicle.applyEngineForce(0, i);
      steer(vehicle, 0, 0);
      vehicle.airControlYaw = 0;
      return;
    }
    const forward = held.has('KeyW') || held.has('ArrowUp');
    const backward = held.has('KeyS') || held.has('ArrowDown');
    const left = held.has('KeyA') || held.has('ArrowLeft');
    const right = held.has('KeyD') || held.has('ArrowRight');
    const handbrakePressed = held.has('Space');
    const turbo = IS_DEV_MODE && (held.has('ShiftLeft') || held.has('ShiftRight'));
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
    const engine = vehicle.engine;
    if (engine?.setManual) {
      engine.setManual(transmission === 'manual');
      engine.onGearEvent = onGearEvent;
    }
    // Manual box: W is the throttle in whatever gear (R included), S always brakes.
    const manual = !!engine?.manual;
    // Opposite key while still moving = brake (at brakeForce), not reverse thrust.
    const pedalBraking = manual
      ? backward
      : (forward && movingBackward) || (backward && (movingForward || backwardBrakeOnly));
    // Gearbox force for wheeled cars. direction 0 while pedal-braking (no
    // premature reverse) but rpm/gear still track wheel speed for the HUD.
    const shiftUp = held.has('KeyE');
    const shiftDown = held.has('KeyQ');
    if (vehicle.engine?.requestShift) {
      if (shiftUp && !shiftUpWasPressed) vehicle.engine.requestShift(1);
      if (shiftDown && !shiftDownWasPressed) vehicle.engine.requestShift(-1);
    }
    shiftUpWasPressed = shiftUp;
    shiftDownWasPressed = shiftDown;
    const engineMagnitude = vehicle.engine
      ? vehicle.engine.update(dt, {
          mode: gearMode,
          direction: manual ? (forward ? 1 : 0) : pedalBraking ? 0 : forward ? 1 : backward ? -1 : 0,
          throttle: manual ? (forward ? 1 : 0) : pedalBraking || !(forward || backward) ? 0 : 1,
          wheelSpeedAbs: Math.abs(vehicle.getDriveWheelSpeed?.() ?? forwardSpeed),
          groundSpeedAbs: Math.abs(forwardSpeed),
          forwardSpeed,
          grounded: driveWheels.some((i) => vehicle.wheelInfos[i]?.isInContact),
          slipping: driveWheels.some((i) => vehicle.wheelInfos[i]?.isInContact && vehicle.wheelInfos[i].sliding),
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

    // Drive sign: forward key forwards (manual: by gear), backward key reverses.
    const driveSign = manual ? (forward ? (engine.gear === 0 ? 1 : -1) : 0) : forward ? -1 : backward ? 1 : 0;
    const engineForce = pedalBraking ? 0 : driveSign * engineMagnitude * forceScale;
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
    if (handbrakeHeld && !handbrakeLatched && handbrakeHeldS >= HANDBRAKE_LATCH_S && holdLatchesHandbrake()) {
      handbrakeLatched = true;
      onHandbrakeLatch?.();
    }
    const handbrake = handbrakeHeld || handbrakeLatched;
    handbrakeOn = handbrake;

    // Per-vehicle brake strength; BRAKE_FORCE fallback.
    const brakeForce = (vehicle.brakeForce ?? BRAKE_FORCE) * forceScale;
    brakePedal = pedalBraking ? Math.min(1, brakePedal + dt / BRAKE_RAMP_S) : 0;
    const pedalBrake = brakePedal * brakeForce;
    // Handbrake locks only the rear (handbrake-axle) wheels, so the rear breaks traction.
    const handbrakeForce = handbrake ? brakeForce : 0;
    // ABS only on the pedal brake; the handbrake must be able to lock.
    const abs = !!vehicle.abs && !vehicle.absOff;
    if (vehicle.applyBrakes) {
      vehicle.applyBrakes(pedalBrake, handbrakeForce, abs);
    } else {
      setFourBrakes(vehicle, pedalBrake, handbrakeForce, handbrake, abs);
    }

    const resetPressed = held.has('KeyR');
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
    isBraking: () => brakePedal > 0,
    /** Pulls the handbrake as if held to latch; the next Space press releases it. */
    latchHandbrake() {
      if (handbrakeLatched) return;
      handbrakeLatched = true;
      onHandbrakeLatch?.();
    },
    /** On: driving keys are ignored (menus over the game). */
    setLocked(on) {
      locked = on;
    },
    isLocked: () => locked,
    getGearMode: () => gearMode,
    toggleGearMode() {
      gearMode = GEAR_MODES[(GEAR_MODES.indexOf(gearMode) + 1) % GEAR_MODES.length];
      saveChoice(GEAR_MODE_STORAGE_KEY, gearMode);
    },
    /** 'auto' | 'manual' as chosen; automatics drive as 'auto' regardless. */
    getTransmission: () => transmission,
    toggleTransmission() {
      transmission = transmission === 'manual' ? 'auto' : 'manual';
      saveChoice(TRANSMISSION_STORAGE_KEY, transmission);
    },
  };
}
