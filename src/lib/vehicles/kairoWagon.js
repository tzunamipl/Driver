import { carAxles } from '../car/axles.js';
import { buildBody } from './geometry/kairoWagon.js';
import { METALLIC_PAINT } from './geometry/paint.js';

export default {
  id: 'C002', // display name in ./names.js
  category: 'cars',
  defaultColor: 0x684e27 | METALLIC_PAINT, // dark umber, metallic
  rimColor: 0xcda434,
  rims: { default: 'spoke5', loose: 'rally6', winter: 'steelBlack' }, // car/rims.js, per tyre compound group
  buildBody,
  wheelRadius: 0.35,
  rimSize: 15,
  tyre: 195,
  profile: 55,
  suspension: {
    suspensionStiffness: 30,
    suspensionRestLength: 0.05,
    maxSuspensionTravel: 0.40,
    rollingResistance: 0.017,
    frictionSlip: 1.0,
    dampingRelaxation: 3.2,
    dampingCompression: 2.1,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'v4',
  enginePowerHp: 112,
  peakTorqueNm: 170,
  peakTorqueRpm: 4000,
  idleRpm: 900,
  redlineRpm: 6000,
  gearRatios: [3.545, 2.111, 1.448, 1.088, 0.825], // EJ20 NA 5MT
  finalDriveRatio: 3.9,
  reverseRatio: 3.636,
  shiftDurationS: 0.9,
  brakeForce: 110,
  abs: true,
  mass: 1300,
  fuelTankL: 50,
  radiator: 1.0,
  coolantL: 6,
  steerSpeedD: 0.007,
  maxSteerAt0: 0.7,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.70, side: 3.4, rear: 1.2 },
  axles: carAxles('awd'),
};
