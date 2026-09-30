import { MAX_FORCE, MAX_STEER, BRAKE_FORCE, TURBO_MULT } from '../config.js';

// Keyboard input: reads raw key state and translates it into vehicle
// control calls each frame. Isolated from the main loop so control
// scheme/tuning (key bindings, force curves) can change independently of
// physics stepping and rendering.

export function createInputController() {
  const keys = new Set();
  window.addEventListener('keydown', (e) => keys.add(e.code));
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  /**
   * Applies current key state to the vehicle's engine/steering/brake, and
   * triggers a car reset on "R". No-ops (and zeroes controls) while the
   * user is typing into a text input, and no-ops entirely if there's no
   * vehicle yet.
   */
  function updateControls(vehicle, reset) {
    if (!vehicle) return;
    const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
    if (typing) {
      vehicle.applyEngineForce(0, 2);
      vehicle.applyEngineForce(0, 3);
      vehicle.setSteeringValue(0, 0);
      vehicle.setSteeringValue(0, 1);
      return;
    }
    const forward = keys.has('KeyW') || keys.has('ArrowUp');
    const backward = keys.has('KeyS') || keys.has('ArrowDown');
    const left = keys.has('KeyA') || keys.has('ArrowLeft');
    const right = keys.has('KeyD') || keys.has('ArrowRight');
    const handbrake = keys.has('Space');
    const turbo = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const forceScale = turbo ? TURBO_MULT : 1;

    const engineForce = (forward ? -MAX_FORCE : backward ? MAX_FORCE : 0) * forceScale;
    // rear-wheel drive (indices 2, 3)
    vehicle.applyEngineForce(engineForce, 2);
    vehicle.applyEngineForce(engineForce, 3);

    const steerValue = left ? MAX_STEER : right ? -MAX_STEER : 0;
    vehicle.setSteeringValue(steerValue, 0);
    vehicle.setSteeringValue(steerValue, 1);

    const brakeForce = handbrake ? BRAKE_FORCE * forceScale : 0;
    for (let i = 0; i < 4; i++) vehicle.setBrake(brakeForce, i);

    if (keys.has('KeyR') && reset) reset();
  }

  return { keys, updateControls };
}
