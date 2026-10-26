import { buildBody, AXLES_Z } from './geometry/president.js';
import { METALLIC_PAINT } from './geometry/paint.js';

// President SX: 5.2 m luxury saloon, 4.4 l V8 with 340 hp, 5-speed,
// rear drive, soft long-travel ride, 245/50 R18.
export default {
  id: 'C018', // display name in ./names.js
  category: 'cars',
  outsideTempGauge: true, // dash LCD: outside temperature
  defaultColor: 0x15181f | METALLIC_PAINT, // midnight black
  rimColor: 0xc8ccd2,
  rims: { default: 'mesh10', winter: 'steel6' }, // car/rims.js, per tyre compound group
  buildBody,
  rimSize: 18,
  tyre: 245,
  profile: 50,
  axles: [
    { z: AXLES_Z[0], halfTrack: 0.82, steer: true },
    { z: AXLES_Z[1], halfTrack: 0.82, driven: true },
  ],
  suspension: {
    suspensionStiffness: 30,
    suspensionRestLength: 0.12,
    maxSuspensionTravel: 0.38,
    rollingResistance: 0.015,
    frictionSlip: 1.0,
    dampingRelaxation: 2.6,
    dampingCompression: 2.0,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'v8',
  enginePowerHp: 340,
  peakTorqueNm: 450,
  peakTorqueRpm: 3800,
  idleRpm: 650,
  redlineRpm: 6300,
  gearRatios: [3.55, 2.24, 1.55, 1.0, 0.79],
  finalDriveRatio: 3.15,
  reverseRatio: 3.68,
  shiftDurationS: 0.5,
  brakeForce: 200,
  tractionControl: true,
  mass: 1950,
  fuelTankL: 85,
  radiator: 1.1,
  coolantL: 11,
  backfire: 0, // 0 no exhaust flame pops .. 1 full
  exhaustTips: [-1, 1].map((sx) => ({ pos: [sx * 0.55, -0.42, -2.66] })),
  steerSpeedD: 0.007,
  maxSteerAt0: 0.65,
  maxSteerAt100: 0.35,
  dragProfile: { front: 0.8, side: 3.0, rear: 1.3 },
};
