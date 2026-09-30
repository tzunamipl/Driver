// Suspension travel HUD: one vertical bar per wheel showing live spring
// travel, read straight from each wheel's Cannon-es WheelInfo. Self-
// contained widget, independent of the other HUDs and of physics tuning.
import { isWheelGrounded } from '../lib/wheelContact.js';

// Debug-mode wheel colouring: green while a wheel is touching the ground,
// blue while it's off the ground (matching the "hasLanded" readout below,
// which reflects the scoring module's own touched-ground gate rather than
// any single wheel). Ground contact here is verified with its own
// world-down raycast (see wheelContact.js) rather than trusting cannon-es's
// own `wheel.isInContact`, which under-reports contact on real terrain.
const WHEEL_ON_GROUND_COLOR = '#4caf50';
const WHEEL_OFF_GROUND_COLOR = '#4fc3ff';

export function createSuspensionHud() {
  // Wheel order matches vehicle.wheelInfos indices (see car.js: front-left,
  // front-right, rear-left, rear-right).
  const wheels = ['fl', 'fr', 'rl', 'rr'].map((key) => ({
    key,
    fill: document.getElementById(`susp-${key}-fill`),
    val: document.getElementById(`susp-${key}-val`),
  }));
  const landedVal = document.getElementById('susp-landed-val');

  /**
   * A bar's fill height is 0% at full droop (fully extended) and 100% at
   * full compression (bottomed out), with a rest-length marker line fixed
   * at 50% - so the fill visibly moves up as a wheel loads/compresses
   * (cornering, braking, bumps) and down as it unloads/droops (cresting a
   * bump, airborne). The fill colour flags ground contact directly: green
   * while the wheel is touching, blue while it's off the ground.
   */
  function updateSuspensionHud(vehicle, debugVisualsEnabled, hasLanded, world) {
    if (!debugVisualsEnabled || !vehicle) return;

    vehicle.wheelInfos.forEach((wheel, i) => {
      const { fill, val } = wheels[i];
      const minLength = wheel.suspensionRestLength - wheel.maxSuspensionTravel;
      const maxLength = wheel.suspensionRestLength + wheel.maxSuspensionTravel;
      const span = maxLength - minLength || 1;
      const clampedLength = Math.min(maxLength, Math.max(minLength, wheel.suspensionLength));
      const compressionFrac = (maxLength - clampedLength) / span;
      const grounded = isWheelGrounded(world, wheel);

      fill.style.height = `${Math.round(compressionFrac * 100)}%`;
      fill.style.background = grounded ? WHEEL_ON_GROUND_COLOR : WHEEL_OFF_GROUND_COLOR;
      val.textContent = grounded ? `${Math.round(compressionFrac * 100)}%` : 'air';
    });

    if (landedVal) landedVal.textContent = hasLanded ? 'true' : 'false';
  }

  return { updateSuspensionHud, el: document.getElementById('suspension-hud') };
}


