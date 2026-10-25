import { buildBody, AXLES_Z } from './geometry/seagul.js';

// Seagul: light fastback coupe set up for drifting. 2.0 twin-cam four with
// 200 hp and a fat mid-range, short close 5-speed so the rear breaks loose
// in 2nd/3rd, rear drive, 50:50 weight, 205/50 R15.
const SUSPENSION = {
  suspensionStiffness: 48,
  suspensionRestLength: 0.08,
  maxSuspensionTravel: 0.3,
  rollingResistance: 0.015,
  frictionSlip: 1.05,
  dampingRelaxation: 3.0,
  dampingCompression: 2.4,
  rollInfluence: 0.3,
  pitchInfluence: 1.0,
};
// Front bites, rear lets go: harder rear tyres.
const REAR_WHEEL = { suspension: { ...SUSPENSION, frictionSlip: 0.92 } };

export default {
  id: 'C020', // display name in ./names.js
  category: 'cars',
  defaultColor: 0xf2f0ea, // white
  rimColor: 0x2a2a2a,
  gloss: 0.6,
  buildBody,
  rimSize: 15,
  tyre: 205,
  profile: 50,
  axles: [
    { z: AXLES_Z[0], halfTrack: 0.7, steer: true },
    { z: AXLES_Z[1], halfTrack: 0.7, driven: true, wheel: REAR_WHEEL },
  ],
  suspension: SUSPENSION,
  suspensionForceG: 8,
  // Rear keeps less grip once sliding (default 0.99), so a drift holds on throttle.
  rearSlideGrip: 0.85,
  engine: 'r4na',
  enginePowerHp: 200,
  peakTorqueNm: 230,
  peakTorqueRpm: 4800,
  idleRpm: 900,
  redlineRpm: 8000,
  gearRatios: [3.17, 2.05, 1.48, 1.16, 0.97],
  finalDriveRatio: 4.56,
  reverseRatio: 3.6,
  shiftDurationS: 0.35,
  brakeForce: 150,
  abs: false,
  mass: 1000,
  fuelTankL: 50,
  radiator: 1.1,
  coolantL: 6,
  backfire: 0.5, // 0 no exhaust flame pops .. 1 full
  exhaustTips: [{ pos: [0.5, -0.36, -2.14] }],
  // Quick rack with big lock for catching and holding angle.
  steerSpeedD: 0.009,
  maxSteerAt0: 1.0,
  maxSteerAt100: 0.6,
  dragProfile: { front: 0.62, side: 2.3, rear: 1.0 },
};
