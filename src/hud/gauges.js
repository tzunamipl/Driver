import { MAX_GAUGE_SPEED, COMPASS_POINTS } from '../config.js';
import { computeHeadingDeg } from '../lib/heading.js';

// Speedometer + compass HUD, driven straight off the vehicle's physics
// state each frame. Self-contained (owns its own DOM refs + smoothing
// state) so it can be wired in/out of the main loop independently of the
// other HUD widgets.

export function createGaugesHud() {
  const speedoNeedle = document.getElementById('speedo-needle');
  const speedoValue = document.getElementById('speedo-value');
  const compassDial = document.getElementById('compass-dial');
  const compassValue = document.getElementById('compass-value');

  // Tracks the dial's continuous (unwrapped) rotation so the CSS
  // transition always nudges across the shortest arc instead of snapping
  // the long way around whenever the heading crosses the 0/360 boundary.
  let compassDialRotation = 0;

  function updateGauges(chassisMesh, vehicle) {
    if (!chassisMesh || !vehicle) return;

    // Speed: physics velocity magnitude (m/s) -> km/h.
    const v = vehicle.chassisBody.velocity;
    const speedKmh = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * 3.6;
    const clamped = Math.min(speedKmh, MAX_GAUGE_SPEED);
    // Needle sweeps -90deg (0 km/h) to +90deg (MAX_GAUGE_SPEED).
    const needleDeg = -90 + (clamped / MAX_GAUGE_SPEED) * 180;
    speedoNeedle.style.transform = `translate(-50%, -100%) rotate(${needleDeg}deg)`;
    speedoValue.textContent = Math.round(speedKmh);

    const headingDeg = computeHeadingDeg(chassisMesh);

    // Rotate the dial opposite the heading so the fixed top pointer always
    // shows the direction the car is currently facing. Unwrap against the
    // previous rotation so the dial always takes the shortest turn, rather
    // than jumping a full lap when headingDeg wraps past 0/360.
    const targetRotation = -headingDeg;
    let delta = ((targetRotation - compassDialRotation + 180) % 360 + 360) % 360 - 180;
    compassDialRotation += delta;
    compassDial.style.transform = `rotate(${compassDialRotation}deg)`;
    const pointIndex = Math.round(headingDeg / 45) % 8;
    compassValue.textContent = COMPASS_POINTS[pointIndex];
  }

  return { updateGauges };
}
