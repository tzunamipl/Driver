import { buildBody } from './geometry/bigfoot.js';

const ENGINE_POWER_HP = 800;
const PEAK_TORQUE_NM = 2000;
const PEAK_TORQUE_RPM = 3000;
const IDLE_RPM = 700;
const REDLINE_RPM = 5200;
const GEAR_RATIOS = [2.22, 1.62, 1.0];
const FINAL_DRIVE_RATIO = 6.17;
const REVERSE_RATIO = 1.82;
const MASS = 2600;
const BRAKE_FORCE = 160;
const DRAG_PROFILE = { front: 4.6, side: 9.9, rear: 5.7 };
const STEER_SPEED_D = 0.01
const MAX_STEER_AT_0 = 0.5;
const MAX_STEER_AT_100 = 0.12;

const WHEEL_RADIUS = 0.75;
const SUSPENSION_FORCE_G = 11;
const SUSPENSION = {
  suspensionStiffness: 15,
  suspensionRestLength: 0.85,
  maxSuspensionTravel: 0.6,
  rollingResistance: 0.03,
  frictionSlip: 1.3,
  dampingRelaxation: 2.71,
  dampingCompression: 0.48,
  rollInfluence: 0.11,
  pitchInfluence: 0.75,
};

const DEFAULT_BODY_COLOR = 0xcc1f1f; // classic monster-truck red

/**
 * Builds a low-poly monster-truck pickup out of primitive boxes/cylinders:
 * a high-riding boxy cab, open truck bed, chunky chrome bumpers, a roll
 * cage, and flame decals streaking back across the hood. The group stands
 * in for the chassis mesh, sized to roughly match the physics chassis
 * footprint (same as every other vehicle - see ./gc8.js). `color` is the
 * painted shell so a remote car can recolor without rebuilding geometry.
 */


/**
 * Vehicle descriptor consumed by lib/vehicles/index.js's registry (and, via
 * that, lib/car.js's shared wheeled-car rig + the lobby's vehicle picker).
 * `wheelRadius`/`suspension`/`enginePowerHp` are read generically by
 * lib/car.js (createCar/createRemoteCar) and app/input.js - see the
 * tunable-parameters comments at the top of this file - so this one
 * descriptor is all it takes to make a truck that rides dramatically
 * higher, soaks up huge drops, and accelerates twice as hard as the
 * baseline rally car, with zero changes needed to the shared rig itself.
 */
export default {
  id: 'bigfoot',
  name: 'Bigfoot Monster Truck',
  category: 'misc',
  defaultColor: DEFAULT_BODY_COLOR,
  buildBody,
  wheelRadius: WHEEL_RADIUS,
  suspension: SUSPENSION,
  suspensionForceG: SUSPENSION_FORCE_G,
  enginePowerHp: ENGINE_POWER_HP,
  peakTorqueNm: PEAK_TORQUE_NM,
  peakTorqueRpm: PEAK_TORQUE_RPM,
  idleRpm: IDLE_RPM,
  redlineRpm: REDLINE_RPM,
  gearRatios: GEAR_RATIOS,
  finalDriveRatio: FINAL_DRIVE_RATIO,
  reverseRatio: REVERSE_RATIO,
  shiftDurationS: 1.8,
  brakeForce: BRAKE_FORCE,
  mass: MASS,
  steerSpeedD: STEER_SPEED_D,
  maxSteerAt0: MAX_STEER_AT_0,
  maxSteerAt100: MAX_STEER_AT_100,
  dragProfile: DRAG_PROFILE,
};
