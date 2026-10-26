import { buildBody, AXLES_Z } from './geometry/kostka.js';

// Kostka: boxy early-80s three-door hatchback, 1.3 l four with 68 hp,
// 5-speed, front drive, light and neutral, 155/70 R13.
export default {
  id: 'C031', // display name in ./names.js
  category: 'cars',
  defaultColor: 0xd94a1a, // orange
  rimColor: 0x9a9ea3,
  rims: { default: 'disc', loose: 'steel4', winter: 'steel4' }, // car/rims.js, per tyre compound group
  gloss: 0.5,
  buildBody,
  rimSize: 13,
  tyre: 155,
  profile: 70,
  axles: [
    { z: AXLES_Z[0], halfTrack: 0.68, steer: true, driven: true },
    { z: AXLES_Z[1], halfTrack: 0.68 },
  ],
  suspension: {
    suspensionStiffness: 32,
    suspensionRestLength: 0.08,
    maxSuspensionTravel: 0.32,
    rollingResistance: 0.015,
    frictionSlip: 1.0,
    dampingRelaxation: 3.0,
    dampingCompression: 1.9,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'r4na',
  enginePowerHp: 68,
  peakTorqueNm: 100,
  peakTorqueRpm: 3000,
  idleRpm: 800,
  redlineRpm: 6200,
  gearRatios: [3.45, 1.94, 1.29, 0.97, 0.8],
  finalDriveRatio: 3.9,
  reverseRatio: 3.17,
  shiftDurationS: 0.6,
  brakeForce: 110,
  abs: false,
  mass: 820,
  fuelTankL: 42,
  radiator: 1.0,
  coolantL: 5,
  exhaustTips: [{ pos: [0.45, -0.42, -1.92] }],
  steerSpeedD: 0.007,
  maxSteerAt0: 0.7,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.64, side: 2.5, rear: 1.0 },
};
