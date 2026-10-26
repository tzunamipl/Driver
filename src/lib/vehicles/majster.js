import { buildBody, AXLES_Z } from './geometry/worker.js';

// Majster: the sane Worker. Same small van body and 1.4 l four (75 hp,
// 5-speed, front drive), but properly damped springs, even grip front to
// rear, a normal steering rack and brakes. Still tall: it leans, mildly
// understeers. 175/65 R14.
export default {
  id: 'C032', // display name in ./names.js
  category: 'cars',
  defaultColor: 0xeeeeea, // fleet white
  rimColor: 0x2a2a2a,
  rims: { default: 'steel6' }, // car/rims.js, per tyre compound group
  gloss: 0.4,
  buildBody,
  rimSize: 14,
  tyre: 175,
  profile: 65,
  axles: [
    { z: AXLES_Z[0], halfTrack: 0.72, steer: true, driven: true },
    { z: AXLES_Z[1], halfTrack: 0.72 },
  ],
  suspension: {
    suspensionStiffness: 30,
    suspensionRestLength: 0.14,
    maxSuspensionTravel: 0.4,
    rollingResistance: 0.016,
    frictionSlip: 0.97,
    dampingRelaxation: 2.6,
    dampingCompression: 1.7,
    rollInfluence: 0.4, // tall body leans more than the usual 0.3
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'r4na',
  enginePowerHp: 75,
  peakTorqueNm: 114,
  peakTorqueRpm: 3000,
  idleRpm: 800,
  redlineRpm: 6000,
  gearRatios: [3.73, 2.05, 1.32, 0.97, 0.76],
  finalDriveRatio: 4.21,
  reverseRatio: 3.55,
  shiftDurationS: 0.7,
  brakeForce: 130,
  abs: true,
  mass: 1150,
  fuelTankL: 50,
  radiator: 1.0,
  coolantL: 6,
  exhaustTips: [{ pos: [0.5, -0.45, -2.1] }],
  steerSpeedD: 0.007,
  maxSteerAt0: 0.7,
  maxSteerAt100: 0.38,
  dragProfile: { front: 1.0, side: 3.4, rear: 1.3 },
};
