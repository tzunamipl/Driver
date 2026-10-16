// Axle layout and steering geometry, shared by the local rig and remote cars.
//
// A descriptor's `axles` lists each axle front to back:
//   { z, halfTrack?, dual?, steer?, steerFadeKmh?, driven?, handbrake?, wheel?, attachY? }
// z / halfTrack are chassis-local metres (halfTrack = axle centre to the
// middle of one wheel set). `dual` mounts twin tyres per side; physics treats
// the pair as one wide wheel. Steered axles all turn about one shared centre
// on the pivot line (default: the middle of the unsteered axles), so a second
// front axle steers less and a steered axle behind the pivot counter-steers.
// `steerFadeKmh` fades that axle's lock out by that speed (rear steer).
// `wheel` overrides the tyre for that axle ({ rimSize, tyre, profile });
// `attachY` its suspension mount height (raise it for a bigger wheel to keep the body level).

import { AXLE_HALF_WIDTH, WHEEL_FRONT_Z, WHEEL_BACK_Z } from './chassis.js';

/** Standard two-axle car on the shared chassis: steered front, `drive` 'fwd' | 'rwd' | 'awd'. */
export function carAxles(drive = 'rwd', halfTrack = AXLE_HALF_WIDTH) {
  return [
    { z: WHEEL_FRONT_Z, halfTrack, steer: true, driven: drive !== 'rwd' },
    { z: WHEEL_BACK_Z, halfTrack, driven: drive !== 'fwd' },
  ];
}

const DEFAULT_AXLES = carAxles('rwd');
const DEFAULT_ACKERMANN = 1;
// Gap between the two tyres of a dual set (m).
const DUAL_GAP_M = 0.04;
// Closest the turn centre may get to a steered wheel (m), so the inner wheel never passes 90 degrees.
const MIN_TURN_ARM_M = 0.3;

/** Descriptor (or trailer) axles with every field filled in. */
export function resolveAxles(axles = DEFAULT_AXLES) {
  return axles.map((a) => ({
    z: a.z,
    halfTrack: a.halfTrack ?? AXLE_HALF_WIDTH,
    dual: !!a.dual,
    steer: !!a.steer,
    steerFadeKmh: a.steerFadeKmh ?? Infinity,
    driven: !!a.driven,
    handbrake: a.handbrake ?? !a.steer,
    wheel: a.wheel ?? null,
    attachY: a.attachY,
  }));
}

/** Physics width of one wheel position: both tyres of a dual set count for grip. */
export function wheelSetWidth(tyreWidth, dual) {
  return dual ? tyreWidth * 2 + DUAL_GAP_M : tyreWidth;
}

/** Lateral offset of each tyre of a set from the set's middle. */
export function tyreOffsets(tyreWidth, dual) {
  const half = (tyreWidth + DUAL_GAP_M) / 2;
  return dual ? [-half, half] : [0];
}

function labelFor(axleIndex, axleCount, side, prefix) {
  const s = side > 0 ? 'L' : 'R';
  if (!prefix && axleCount === 2) return (axleIndex === 0 ? 'F' : 'R') + s;
  return `${prefix}${axleIndex + 1}${s}`;
}

/**
 * One entry per wheel position, left (+x, renders on screen-left) before
 * right on each axle, so a 2-axle car keeps the FL, FR, RL, RR order.
 */
export function layoutWheels(axles, attachY, labelPrefix = '') {
  const wheels = [];
  axles.forEach((axle, axleIndex) => {
    for (const side of [1, -1]) {
      wheels.push({
        axle,
        x: side * axle.halfTrack,
        y: axle.attachY ?? attachY,
        z: axle.z,
        side,
        label: labelFor(axleIndex, axles.length, side, labelPrefix),
      });
    }
  });
  return wheels;
}

/**
 * Steering geometry for a set of axles. `angles(steer, speedKmh, wheels, out)`
 * maps the driver's steer input (the angle of a virtual wheel on the
 * centreline of the front-most steered axle, + = left) to every wheel.
 */
export function createSteeringGeometry(axles, { ackermann = DEFAULT_ACKERMANN, steerPivotZ } = {}) {
  const steered = axles.filter((a) => a.steer);
  const fixed = axles.filter((a) => !a.steer);
  const mean = (list) => list.reduce((sum, a) => sum + a.z, 0) / list.length;
  const pivotZ = steerPivotZ ?? (fixed.length ? mean(fixed) : mean(axles));
  const refZ = steered.length ? Math.max(...steered.map((a) => a.z)) : pivotZ;
  const refArm = refZ - pivotZ;

  function wheelAngle(steer, wheel) {
    const arm = wheel.z - pivotZ;
    // Degenerate layout (front-most steered axle on the pivot line): plain steer.
    if (Math.abs(refArm) < 1e-3) return steer;
    if (Math.abs(steer) < 1e-5) return (steer * arm) / refArm;
    // Turn centre on the pivot line, lateral offset +x = left.
    const centreX = refArm / Math.tan(steer);
    const parallel = Math.atan(arm / centreX);
    let lateral = centreX - wheel.x;
    if (Math.sign(lateral) !== Math.sign(centreX) || Math.abs(lateral) < MIN_TURN_ARM_M) {
      lateral = Math.sign(centreX) * MIN_TURN_ARM_M;
    }
    const exact = Math.atan(arm / lateral);
    return parallel + (exact - parallel) * ackermann;
  }

  function angles(steer, speedKmh, wheels, out) {
    for (let i = 0; i < wheels.length; i++) {
      const wheel = wheels[i];
      if (!wheel.axle.steer) {
        out[i] = 0;
        continue;
      }
      const fade = Math.max(0, 1 - Math.abs(speedKmh) / wheel.axle.steerFadeKmh);
      out[i] = wheelAngle(steer, wheel) * fade;
    }
    return out;
  }

  return { pivotZ, refZ, angles };
}

/** Lobby drive label: FWD/RWD/AWD for 2-axle cars, wheels x driven otherwise (e.g. 8x8). */
export function driveLabel(descriptor) {
  const axles = resolveAxles(descriptor.axles);
  const driven = axles.filter((a) => a.driven);
  if (axles.length === 2) {
    if (driven.length === 2) return 'AWD';
    return driven[0] === axles[0] ? 'FWD' : 'RWD';
  }
  return `${axles.length * 2}x${driven.length * 2}`;
}
