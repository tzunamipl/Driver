import { FIXED_STEP } from '../config.js';

// Hull drag while wading: a = k(depth) * v^2 on horizontal velocity, as an
// acceleration so every vehicle reaches a similar crawl. k grows exponentially
// with depth: streams barely slow you, deep water allows only walking pace
// (~8 km/h for a sports car, ~5 km/h for a truck at full depth).
const DRAG_PER_DEPTH_BASE = 0.0012; // 1/m, scales the exponential
const DRAG_DEPTH_SCALE_M = 0.27; // k grows e-fold every this many metres
// Braking cap, so a fast entry decelerates hard but not in one step.
const MAX_WATER_DECEL = 20; // m/s^2
// Never remove more than this share of the speed in one step (no reversal).
const MAX_STEP_SPEED_SHARE = 0.5;

/** Applies one step of water drag to `body` at `depth` metres of water. */
export function applyWaterDrag(body, depth) {
  if (!(depth > 0)) return;
  const v = body.velocity;
  const speed = Math.hypot(v.x, v.z);
  if (speed < 1e-3) return;
  const k = DRAG_PER_DEPTH_BASE * (Math.exp(depth / DRAG_DEPTH_SCALE_M) - 1);
  const decel = Math.min(k * speed * speed, MAX_WATER_DECEL, (speed * MAX_STEP_SPEED_SHARE) / FIXED_STEP);
  const scale = (-body.mass * decel) / speed;
  body.force.x += v.x * scale;
  body.force.z += v.z * scale;
}
