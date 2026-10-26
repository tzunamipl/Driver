import { carAxles } from '../car/axles.js';
import { buildBody } from './geometry/attackerRS.js';

// Attacker RS, Group A rally spec (gravel 205/65 R15,
// 2.0 turbo restricted to ~300 hp, 6-speed sequential).
export default {
  id: 'C009', // display name in ./names.js
  category: 'rally',
  defaultColor: 0xc8102e, // red
  rimColor: 0xf5f5f5,
  rims: { default: 'rally8', loose: 'rally6', winter: 'rally6' }, // car/rims.js, per tyre compound group
  buildBody,
  rimSize: 15,
  tyre: 205,
  profile: 65,
  tyreCompound: 'gravelHard', // tyres/compounds.js
  suspension: {
    suspensionStiffness: 45,
    suspensionRestLength: 0.15,
    maxSuspensionTravel: 0.5,
    rollingResistance: 0.015,
    frictionSlip: 1.1,
    dampingRelaxation: 5.3,
    dampingCompression: 3.7,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'r4',
  enginePowerHp: 300,
  peakTorqueNm: 510,
  peakTorqueRpm: 3500,
  idleRpm: 1000,
  redlineRpm: 7500,
  turbo: { boostBar: 1.3, spoolRpm: 3500, lagS: 0.45 }, // bar, full-boost rpm, spool lag (s)
  launchRpm: 4500, // launches on boost
  gearRatios: [3.0, 2.1, 1.6, 1.28, 1.05, 0.88],
  finalDriveRatio: 4.529,
  reverseRatio: 3.416,
  shiftDurationS: 0.25,
  brakeForce: 200,
  abs: false,
  mass: 1230,
  fuelTankL: 60,
  radiator: 1.15,
  coolantL: 7,
  backfire: 0.3, // 0 no exhaust flame pops .. 1 full
  exhaustTips: [{ pos: [-0.5, -0.27, -2.24] }],
  steerSpeedD: 0.007,
  maxSteerAt0: 0.7,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.66, side: 2.2, rear: 1.2 },
  axles: carAxles('awd'),
};
