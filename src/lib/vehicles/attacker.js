import { carAxles } from '../car/axles.js';
import { buildRoadBody } from './geometry/attackerRS.js';
import { METALLIC_PAINT } from './geometry/paint.js';

// Attacker: the road car the RS is built from. 2.0 turbo with 280 hp,
// 5-speed, four-wheel drive, ABS, road tyres 235/45 R17, softer ride.
export default {
  id: 'C023', // display name in ./names.js
  category: 'cars',
  defaultColor: 0x1b3f8f | METALLIC_PAINT, // deep blue
  rimColor: 0xb8bcc2,
  rims: { default: 'spoke5', loose: 'rally6', winter: 'steel6' }, // car/rims.js, per tyre compound group
  buildBody: buildRoadBody,
  rimSize: 17,
  tyre: 235,
  profile: 45,
  suspension: {
    suspensionStiffness: 42,
    suspensionRestLength: 0.12,
    maxSuspensionTravel: 0.4,
    rollingResistance: 0.015,
    frictionSlip: 1.0,
    dampingRelaxation: 3.2,
    dampingCompression: 2.4,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'r4',
  enginePowerHp: 280,
  peakTorqueNm: 375,
  peakTorqueRpm: 3500,
  idleRpm: 850,
  redlineRpm: 7000,
  turbo: { boostBar: 1.0, spoolRpm: 3000, lagS: 0.6 }, // bar, full-boost rpm, spool lag (s)
  gearRatios: [2.79, 1.95, 1.42, 1.09, 0.84],
  finalDriveRatio: 4.53,
  reverseRatio: 3.42,
  shiftDurationS: 0.55,
  brakeForce: 190,
  brakes: { front: { discMm: 330, vented: true }, rear: { discMm: 300 } },
  tractionControl: true,
  mass: 1400,
  fuelTankL: 55,
  radiator: 1.05,
  coolantL: 7,
  backfire: 0.1, // 0 no exhaust flame pops .. 1 full
  exhaustTips: [{ pos: [-0.5, -0.27, -2.24] }],
  steerSpeedD: 0.007,
  maxSteerAt0: 0.7,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.66, side: 2.2, rear: 1.2 },
  axles: carAxles('awd'),
};
