import { carAxles } from '../car/axles.js';
import { buildBody } from './geometry/kairoS.js';
import { METALLIC_PAINT } from './geometry/paint.js';

export default {
  id: 'C001', // display name in ./names.js
  category: 'cars',
  defaultColor: 0x7e5e25 | METALLIC_PAINT, // dusky bronze, metallic
  rimColor: 0xcda434,
  rims: { default: 'spoke5', loose: 'rally6', winter: 'steelBlack' }, // car/rims.js, per tyre compound group
  buildBody,
  wheelRadius: 0.35,
  rimSize: 17,
  tyre: 225,
  profile: 35,
  axles: carAxles('awd'),
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
  exhaustTips: [{ pos: [-0.52, -0.295, -2.2] }],
  gearRatios: [3.454, 2.062, 1.448, 1.088, 0.825], // TY75 5MT
  finalDriveRatio: 4.111,
  reverseRatio: 3.636,
  shiftDurationS: 0.6,
  brakeForce: 180,
  brakes: { front: { discMm: 312, vented: true }, rear: { discMm: 272 } },
  abs: false,
  mass: 1300,
  fuelTankL: 50,
  radiator: 1.05,
  coolantL: 7,
  steerSpeedD: 0.007,
  maxSteerAt0: 0.7,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.68, side: 2.4, rear: 1.2 },
};
