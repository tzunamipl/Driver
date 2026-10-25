import { buildBody } from './geometry/v8Eagle.js';

// V8 Eagle: early-70s muscle coupe with a blown 5.8 l V8,
// 4-speed manual, wider rear tyres, rear drive.
export default {
  id: 'C017', // display name in ./names.js
  category: 'postapo',
  defaultColor: 0x111111,
  rimColor: 0x1c1c1c,
  gloss: 0.3, // dusty black
  buildBody,
  rimSize: 15,
  tyre: 225,
  profile: 60,
  axles: [
    { z: 1.4, halfTrack: 0.78, steer: true },
    { z: -1.42, halfTrack: 0.76, driven: true, wheel: { tyre: 255 } },
  ],
  suspension: {
    suspensionStiffness: 38,
    suspensionRestLength: 0.15,
    maxSuspensionTravel: 0.4,
    rollingResistance: 0.015,
    frictionSlip: 1.0,
    dampingRelaxation: 3.2,
    dampingCompression: 2.1,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'v8',
  enginePowerHp: 600,
  peakTorqueNm: 750,
  peakTorqueRpm: 4500,
  idleRpm: 850,
  redlineRpm: 6800,
  // Belt-driven blower: boost follows rpm, no lag.
  turbo: { boostBar: 0.7, spoolRpm: 2500, lagS: 0.05 }, // bar, full-boost rpm, spool lag (s)
  gearRatios: [2.78, 1.93, 1.36, 1.0],
  finalDriveRatio: 3.5,
  reverseRatio: 2.78,
  shiftDurationS: 0.45,
  brakeForce: 190,
  abs: false,
  mass: 1550,
  fuelTankL: 180, // twin boot tanks
  radiator: 0.85, // supercharged V8 behind a small grille: runs hot
  coolantL: 16,
  backfire: 1, // 0 no exhaust flame pops .. 1 full
  exhaustTips: [-1, 1].map((sx) => ({ pos: [sx * 0.95, -0.3, 0.56], dir: [sx * 0.15, 0, -1] })), // zoomie side pipes
  steerSpeedD: 0.007,
  maxSteerAt0: 0.9,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.9, side: 2.6, rear: 1.3 },
  proxyBox: [1.9, 1.3, 4.7, 0],
};
