import { buildBody, AXLES_Z } from './geometry/worker.js';

// Worker: small leisure van with dreadful manners. 1.4 l four with 75 hp,
// 5-speed, front drive. Tall, soft and underdamped: it rolls, pitches and
// washes wide on the hard fronts, then the light rear lets go on a lift.
// Slow, vague rack, weak brakes, 175/65 R14.
const SUSPENSION = {
  suspensionStiffness: 22,
  suspensionRestLength: 0.16,
  maxSuspensionTravel: 0.45,
  rollingResistance: 0.016,
  frictionSlip: 0.85,
  dampingRelaxation: 1.0,
  dampingCompression: 0.7,
  rollInfluence: 0.6,
  pitchInfluence: 1.0,
};
const REAR_WHEEL = { suspension: { ...SUSPENSION, frictionSlip: 0.8 } };

export default {
  id: 'C030', // display name in ./names.js
  category: 'dumb',
  defaultColor: 0x8fb0c4, // pale blue
  rimColor: 0x2a2a2a,
  rims: { default: 'steel6' }, // car/rims.js, per tyre compound group
  gloss: 0.4,
  buildBody,
  rimSize: 14,
  tyre: 175,
  profile: 65,
  axles: [
    { z: AXLES_Z[0], halfTrack: 0.72, steer: true, driven: true },
    { z: AXLES_Z[1], halfTrack: 0.72, wheel: REAR_WHEEL },
  ],
  suspension: SUSPENSION,
  suspensionForceG: 8,
  rearSlideGrip: 0.75, // once the rear breaks away it keeps going
  engine: 'r4na',
  enginePowerHp: 75,
  peakTorqueNm: 114,
  peakTorqueRpm: 3000,
  idleRpm: 800,
  redlineRpm: 6000,
  gearRatios: [3.73, 2.05, 1.32, 0.97, 0.76],
  finalDriveRatio: 4.21,
  reverseRatio: 3.55,
  shiftDurationS: 0.8,
  brakeForce: 95,
  brakes: { front: { discMm: 256 }, rear: { drumMm: 228 } },
  brakeBias: 0.55, // rear-heavy brakes lock the rear first
  abs: false,
  mass: 1150,
  fuelTankL: 50,
  radiator: 1.0,
  coolantL: 6,
  exhaustTips: [{ pos: [0.5, -0.45, -2.1] }],
  steerSpeedD: 0.004,
  maxSteerAt0: 0.55,
  maxSteerAt100: 0.25,
  dragProfile: { front: 1.0, side: 3.4, rear: 1.3 },
};
