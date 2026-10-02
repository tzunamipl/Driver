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
    const engineForce = (forward ? -engineForceUnit : backward ? engineForceUnit : 0) * forceScale;
    // rear-wheel drive (indices 2, 3)
    vehicle.applyEngineForce(engineForce, 2);
    vehicle.applyEngineForce(engineForce, 3);

    const steerValue = left ? MAX_STEER : right ? -MAX_STEER : 0;
    vehicle.setSteeringValue(steerValue, 0);
    vehicle.setSteeringValue(steerValue, 1);
    vehicle.airControlYaw = left ? 1 : right ? -1 : 0;

    // vehicle.brakeForce is each vehicle's own independent handbrake
    // strength (see lib/car.js's createCar), set per-rig from its
    // descriptor the same way engineForce is above - BRAKE_FORCE is only
    // a fallback for rigs that don't set one (e.g. the hover chariot,
    // which only treats this as a +0 boolean, not an actual force).
    const brakeForce = handbrake ? (vehicle.brakeForce ?? BRAKE_FORCE) * forceScale : 0;
    for (let i = 0; i < 4; i++) vehicle.setBrake(brakeForce, i);

    const resetPressed = keys.has('KeyR');
    if (resetPressed && !resetWasPressed && reset) reset();
    resetWasPressed = resetPressed;
  }

  function isTyping() {
    return isTypingInField();
  }

  return { keys, updateControls, isTyping };
}
