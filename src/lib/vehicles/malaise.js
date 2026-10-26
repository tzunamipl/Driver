import { buildBody, AXLES_Z } from './geometry/malaise.js';
import { METALLIC_PAINT } from './geometry/paint.js';

// Malaise: small late-70s two-door saloon with a smog-choked 5.0 l V8:
// 130 hp, lots of low-down torque and nothing past 4000 rpm, 3-speed,
// rear drive, soft floaty springs, slow steering, 195/75 R14, drum brakes.
export default {
  id: 'C028', // display name in ./names.js
  category: 'cars',
  defaultColor: 0x6e4a26 | METALLIC_PAINT, // tobacco brown
  rimColor: 0xc8ccd2,
  rims: { default: 'hubcap' }, // car/rims.js, per tyre compound group
  buildBody,
  rimSize: 14,
  tyre: 195,
  profile: 75,
  axles: [
    { z: AXLES_Z[0], halfTrack: 0.74, steer: true },
    { z: AXLES_Z[1], halfTrack: 0.74, driven: true },
  ],
  suspension: {
    suspensionStiffness: 22,
    suspensionRestLength: 0.15,
    maxSuspensionTravel: 0.42,
    rollingResistance: 0.017,
    frictionSlip: 0.95,
    dampingRelaxation: 1.4,
    dampingCompression: 1.0,
    rollInfluence: 0.45,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'v8',
  enginePowerHp: 130,
  peakTorqueNm: 320,
  peakTorqueRpm: 1800,
  idleRpm: 600,
  redlineRpm: 4200,
  gearRatios: [2.46, 1.46, 1.0],
  finalDriveRatio: 2.79,
  reverseRatio: 2.18,
  shiftDurationS: 0.7,
  brakeForce: 110,
  abs: false,
  mass: 1500,
  fuelTankL: 70,
  radiator: 0.85, // runs hot
  coolantL: 14,
  backfire: 0, // 0 no exhaust flame pops .. 1 full
  exhaustTips: [{ pos: [-0.55, -0.46, -2.32] }],
  steerSpeedD: 0.005,
  maxSteerAt0: 0.6,
  maxSteerAt100: 0.3,
  dragProfile: { front: 0.9, side: 2.8, rear: 1.3 },
};
