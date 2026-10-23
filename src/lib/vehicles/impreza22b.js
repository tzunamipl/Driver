import { carAxles } from '../car/axles.js';
import { buildBody } from './geometry/impreza22b.js';

// Subaru Impreza 22B STi (1998): widebody coupe homologation special, 2.2
// EJ22 turbo boxer, 235/40 R17 on gold BBS, wider track than the GC8.
export default {
  id: 'impreza-22b',
  name: 'Impreza 22B STi',
  category: 'wrc',
  defaultColor: 0x1e3f9e, // Sonic Blue Mica
  rimColor: 0xcda434,
  buildBody,
  rimSize: 17,
  tyre: 235,
  profile: 40,
  axles: carAxles('awd', 0.83),
  suspension: {
    suspensionStiffness: 48,
    suspensionRestLength: 0.12,
    maxSuspensionTravel: 0.42,
    rollingResistance: 0.015,
    frictionSlip: 1.1,
    dampingRelaxation: 5.5,
    dampingCompression: 3.5,
    rollInfluence: 0.18,
    pitchInfluence: 0.6,
  },
  suspensionForceG: 8,
  engine: 'v4',
  enginePowerHp: 276,
  peakTorqueNm: 363,
  peakTorqueRpm: 3200,
  idleRpm: 900,
  redlineRpm: 7500,
  gearRatios: [3.083, 2.062, 1.545, 1.151, 0.825],
  finalDriveRatio: 4.444,
  reverseRatio: 3.545,
  shiftDurationS: 0.45,
  brakeForce: 200,
  abs: false,
  mass: 1270,
  fuelTankL: 60,
  steerSpeedD: 0.005,
  maxSteerAt0: 0.5,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.85, side: 2.4, rear: 1.25 },
};
