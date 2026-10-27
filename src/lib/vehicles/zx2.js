import { buildBody, AXLES_Z } from './geometry/zx2.js';
import { METALLIC_PAINT } from './geometry/paint.js';

// ZX2: compact sport saloon, 3.0 l straight six with 245 hp, 6-speed,
// rear drive, 225/45 R17.
export default {
  id: 'C019', // display name in ./names.js
  category: 'cars',
  outsideTempGauge: true, // dash LCD: outside temperature
  defaultColor: 0xc0c5ca | METALLIC_PAINT, // titanium silver
  rimColor: 0x8a8e94,
  rims: { default: 'spoke5Twist', loose: 'rally6', winter: 'steel6' }, // car/rims.js, per tyre compound group
  buildBody,
  rimSize: 17,
  tyre: 225,
  profile: 45,
  axles: [
    { z: AXLES_Z[0], halfTrack: 0.77, steer: true },
    { z: AXLES_Z[1], halfTrack: 0.77, driven: true },
  ],
  suspension: {
    suspensionStiffness: 42,
    suspensionRestLength: 0.1,
    maxSuspensionTravel: 0.35,
    rollingResistance: 0.015,
    frictionSlip: 1.0,
    dampingRelaxation: 3.0,
    dampingCompression: 2.4,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'r6',
  enginePowerHp: 245,
  peakTorqueNm: 300,
  peakTorqueRpm: 4500,
  idleRpm: 750,
  redlineRpm: 7000,
  gearRatios: [4.23, 2.53, 1.67, 1.23, 1.0, 0.83],
  finalDriveRatio: 3.46,
  reverseRatio: 3.75,
  shiftDurationS: 0.5,
  brakeForce: 170,
  brakes: { front: { discMm: 316, vented: true }, rear: { discMm: 290 } },
  mass: 1450,
  fuelTankL: 63,
  radiator: 1.0,
  coolantL: 8.5,
  backfire: 0.2, // 0 no exhaust flame pops .. 1 full
  exhaustTips: [-1, 1].map((sx) => ({ pos: [sx * 0.62, -0.42, -2.36] })),
  steerSpeedD: 0.007,
  maxSteerAt0: 0.7,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.66, side: 2.5, rear: 1.15 },
};
