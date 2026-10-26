import { carAxles } from '../car/axles.js';
import { buildRoadBody } from './geometry/stallionTurbo.js';

// Stallion: the everyday five-door the Turbo is built from. 2.0 with
// 140 hp, 5-speed, front drive, 205/55 R16.
export default {
  id: 'C024', // display name in ./names.js
  category: 'cars',
  defaultColor: 0x7a8c96, // grey blue
  rimColor: 0xb8bcc2,
  rims: { default: 'hubcap', loose: 'steel4', winter: 'steel4' }, // car/rims.js, per tyre compound group
  buildBody: buildRoadBody,
  rimSize: 16,
  tyre: 205,
  profile: 55,
  axles: carAxles('fwd', 0.8),
  suspension: {
    suspensionStiffness: 34,
    suspensionRestLength: 0.1,
    maxSuspensionTravel: 0.38,
    rollingResistance: 0.015,
    frictionSlip: 1.0,
    dampingRelaxation: 3.0,
    dampingCompression: 2.0,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'r4na',
  enginePowerHp: 140,
  peakTorqueNm: 185,
  peakTorqueRpm: 4500,
  idleRpm: 800,
  redlineRpm: 6500,
  gearRatios: [3.58, 1.93, 1.28, 0.95, 0.76],
  finalDriveRatio: 4.06,
  reverseRatio: 3.62,
  shiftDurationS: 0.65,
  brakeForce: 150,
  tractionControl: true,
  mass: 1250,
  fuelTankL: 55,
  radiator: 1.0,
  coolantL: 6,
  exhaustTips: [{ pos: [0.45, -0.3, -2.02] }],
  steerSpeedD: 0.007,
  maxSteerAt0: 0.7,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.8, side: 2.4, rear: 1.25 },
};
