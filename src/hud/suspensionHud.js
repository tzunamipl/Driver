// Suspension travel HUD: one vertical bar per wheel/hover-point showing
// live spring travel, read straight from each entry's Cannon-es-style
// WheelInfo. Self-contained widget, independent of the other HUDs and of
// physics tuning. Bars are built dynamically from vehicle.wheelInfos (in
// order) and labelled from vehicle.wheelLabels (falling back to a plain
// index if a vehicle kind doesn't provide one) - so this one HUD works
// unmodified for lib/car.js's 4 fixed wheels (FL/FR/RL/RR) and for
// lib/chariot.js's variable engine count + pod (E1/E2/.../POD), instead of
// being hardcoded to exactly 4 wheels.
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
  const grid = document.getElementById('susp-grid');
  const landedVal = document.getElementById('susp-landed-val');
  // Rebuilt lazily whenever the attached vehicle's wheel count/labels
  // change (e.g. switching between a car and a pod racer) rather than on
  // every frame - tracked by a simple signature string.
  let bars = [];
  let lastSignature = '';

  function rebuildBars(wheelInfos, labels) {
    grid.innerHTML = '';
    bars = wheelInfos.map((_, i) => {
      const label = labels?.[i] ?? String(i);
      const wheelEl = document.createElement('div');
      wheelEl.className = 'susp-wheel';
      wheelEl.innerHTML =
        '<div class="susp-bar"><div class="susp-rest-line"></div><div class="susp-fill"></div></div>' +
        `<div class="susp-label">${label} <span class="susp-val">&mdash;</span></div>`;
      grid.appendChild(wheelEl);
      return {
        fill: wheelEl.querySelector('.susp-fill'),
        val: wheelEl.querySelector('.susp-val'),
      };
    });
  }

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

    const signature = `${vehicle.wheelInfos.length}:${vehicle.wheelLabels?.join(',') ?? ''}`;
    if (signature !== lastSignature) {
      rebuildBars(vehicle.wheelInfos, vehicle.wheelLabels);
      lastSignature = signature;
    }

    vehicle.wheelInfos.forEach((wheel, i) => {
      const { fill, val } = bars[i];
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


