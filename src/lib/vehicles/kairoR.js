import { carAxles } from '../car/axles.js';
import { buildBody } from './geometry/kairoR.js';

// Kairo R: widebody coupe homologation special, 2.2 turbo boxer,
// 235/40 R17 on gold rims, wider track than the Kairo S.
export default {
  id: 'C010', // display name in ./names.js
  category: 'rally',
  defaultColor: 0xe67e00, // tangerine orange
  rimColor: 0xcda434,
  rims: { default: 'spoke5', loose: 'rally6', winter: 'rally6' }, // car/rims.js, per tyre compound group
  buildBody,
  rimSize: 17,
  tyre: 235,
  profile: 40,
  tyreCompound: 'gravelHard', // tyres/compounds.js
  axles: carAxles('awd', 0.83),
  suspension: {
    suspensionStiffness: 48,
    suspensionRestLength: 0.12,
    maxSuspensionTravel: 0.42,
    rollingResistance: 0.015,
    frictionSlip: 1.1,
    dampingRelaxation: 5.5,
    dampingCompression: 3.5,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'v4',
  enginePowerHp: 276,
  peakTorqueNm: 363,
  peakTorqueRpm: 3200,
  idleRpm: 900,
  redlineRpm: 7500,
  turbo: { boostBar: 1.1, spoolRpm: 3200, lagS: 0.5 }, // bar, full-boost rpm, spool lag (s)
  launchRpm: 4000, // launches on boost
  gearRatios: [3.083, 2.062, 1.545, 1.151, 0.825],
  finalDriveRatio: 4.444,
  reverseRatio: 3.545,
  shiftDurationS: 0.45,
  brakeForce: 200,
  abs: false,
  mass: 1270,
  fuelTankL: 60,
  radiator: 1.15,
  coolantL: 7.5,
  backfire: 0.3,
  steerSpeedD: 0.007,
  maxSteerAt0: 0.7,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.74, side: 2.4, rear: 1.25 },
};
