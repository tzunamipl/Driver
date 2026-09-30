// Suspension travel HUD: one vertical bar per wheel showing live spring
// travel, read straight from each wheel's Cannon-es WheelInfo. Self-
// contained widget, independent of the other HUDs and of physics tuning.

/**
 * Colors a suspension bar by how hard the spring is working: blue for
 * normal travel, yellow as it approaches full compression, red once it's
 * essentially bottomed out (spring at/near its max travel limit).
 */
function suspensionColor(compressionFrac) {
  if (compressionFrac > 0.85) return '#ff5b5b';
  if (compressionFrac > 0.6) return '#ffce4f';
  return '#4fc3ff';
}

export function createSuspensionHud() {
  // Wheel order matches vehicle.wheelInfos indices (see car.js: front-left,
  // front-right, rear-left, rear-right).
  const wheels = ['fl', 'fr', 'rl', 'rr'].map((key) => ({
    key,
    fill: document.getElementById(`susp-${key}-fill`),
    val: document.getElementById(`susp-${key}-val`),
  }));

  /**
   * A bar's fill height is 0% at full droop (fully extended) and 100% at
   * full compression (bottomed out), with a rest-length marker line fixed
   * at 50% - so the fill visibly moves up as a wheel loads/compresses
   * (cornering, braking, bumps) and down as it unloads/droops (cresting a
   * bump, airborne). Wheels not currently touching the ground are dimmed
   * and shown resting at the midpoint, since cannon-es reports their
   * suspension as fully extended (no ground to push back against) while
   * airborne.
   */
  function updateSuspensionHud(vehicle, debugVisualsEnabled) {
    if (!debugVisualsEnabled || !vehicle) return;

    vehicle.wheelInfos.forEach((wheel, i) => {
      const { fill, val } = wheels[i];
      const minLength = wheel.suspensionRestLength - wheel.maxSuspensionTravel;
      const maxLength = wheel.suspensionRestLength + wheel.maxSuspensionTravel;
      const span = maxLength - minLength || 1;
      const clampedLength = Math.min(maxLength, Math.max(minLength, wheel.suspensionLength));
      const compressionFrac = (maxLength - clampedLength) / span;

      fill.style.height = `${Math.round(compressionFrac * 100)}%`;
      fill.style.background = wheel.isInContact
        ? suspensionColor(compressionFrac)
        : 'rgba(255, 255, 255, 0.25)';
      val.textContent = wheel.isInContact ? `${Math.round(compressionFrac * 100)}%` : 'air';
    });
  }

  return { updateSuspensionHud, el: document.getElementById('suspension-hud') };
}
