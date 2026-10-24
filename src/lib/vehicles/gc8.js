import { carAxles } from '../car/axles.js';
import { buildBody } from './geometry/gc8.js';

export default {
  id: 'gc8',
  name: 'GC8',
  category: 'cars',
  defaultColor: 0x1d3c8f, // WR blue
  rimColor: 0xcda434,
  buildBody,
  wheelRadius: 0.35,
  rimSize: 17,
  tyre: 225,
  profile: 35,
  suspension: {
    suspensionStiffness: 45,
    suspensionRestLength: 0.1,
    maxSuspensionTravel: 0.4,
    rollingResistance: 0.015,
    frictionSlip: 1.0,
    dampingRelaxation: 2.4,
    dampingCompression: 3.8,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'v4',
  enginePowerHp: 211,
  peakTorqueNm: 350,
  peakTorqueRpm: 4000,
  idleRpm: 900,
  redlineRpm: 7000,
  turbo: { boostBar: 1.0, spoolRpm: 3200, lagS: 0.55 }, // bar, full-boost rpm, spool lag (s)
  gearRatios: [3.454, 2.062, 1.448, 1.088, 0.825], // TY75 5MT
  finalDriveRatio: 4.111,
  reverseRatio: 3.636,
  shiftDurationS: 0.6,
  brakeForce: 180,
  abs: false,
  mass: 1300,
  fuelTankL: 50,
  steerSpeedD: 0.005,
  maxSteerAt0: 0.5,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.68, side: 2.4, rear: 1.2 },
  axles: carAxles('awd'),
};
