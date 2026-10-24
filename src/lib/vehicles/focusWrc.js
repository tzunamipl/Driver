import { carAxles } from '../car/axles.js';
import { buildBody } from './geometry/focusWrc.js';

// Ford Focus RS WRC (2001), tarmac spec: 2.0 Duratec turbo on the 34 mm
// restrictor (~300 hp, huge mid-range torque), 5-speed sequential, 18" rims.
export default {
  id: 'focus-wrc',
  name: 'Focus RS WRC',
  category: 'wrc',
  defaultColor: 0xf4f4f2, // Martini white
  rimColor: 0xe8e8e8,
  buildBody,
  rimSize: 18,
  tyre: 225,
  profile: 40,
  axles: carAxles('awd', 0.82),
  suspension: {
    suspensionStiffness: 50,
    suspensionRestLength: 0.15,
    maxSuspensionTravel: 0.45,
    rollingResistance: 0.015,
    frictionSlip: 1.1,
    dampingRelaxation: 5.7,
    dampingCompression: 3.3,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'r4',
  enginePowerHp: 300,
  peakTorqueNm: 550,
  peakTorqueRpm: 4000,
  idleRpm: 1100,
  redlineRpm: 7500,
  // Anti-lag keeps it nearly lag-free.
  turbo: { boostBar: 1.5, spoolRpm: 3000, lagS: 0.2 }, // bar, full-boost rpm, spool lag (s)
  launchRpm: 4500, // launches on boost
  gearRatios: [2.92, 2.12, 1.64, 1.3, 1.06],
  finalDriveRatio: 3.95, // fast tarmac stage gearing, ~215 km/h at the limiter
  reverseRatio: 3.2,
  shiftDurationS: 0.15,
  brakeForce: 210,
  abs: false,
  mass: 1230,
  fuelTankL: 80,
  radiator: 1.4, // rally-spec radiator
  coolantL: 8,
  backfire: 0.5,
  exhaustTips: [{ pos: [0.45, -0.2, -2.02] }],
  steerSpeedD: 0.005,
  maxSteerAt0: 0.52,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.85, side: 2.4, rear: 1.3 },
};
