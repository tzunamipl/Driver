import { buildBody, AXLES_Z } from './geometry/super.js';

// Super: compact mid-engined supercar, 4.0 twin-turbo V8 with 680 hp,
// 7-speed, rear drive on staggered 245/35 R19 + 305/30 R20.
const REAR_WHEEL = { rimSize: 20, tyre: 305, profile: 30 };
// Front 245/35 R19 is 19 mm smaller in radius: mount the rear that much higher to sit level.
const REAR_ATTACH_Y = -0.3 + 0.019;

export default {
  id: 'C026', // display name in ./names.js
  category: 'cars',
  defaultColor: 0xe8b400, // yellow
  rimColor: 0x1e1e20,
  buildBody,
  rimSize: 19,
  tyre: 245,
  profile: 35,
  tyreCompound: 'semiSlickHard', // tyres/compounds.js
  axles: [
    { z: AXLES_Z[0], halfTrack: 0.83, steer: true },
    { z: AXLES_Z[1], halfTrack: 0.8, driven: true, wheel: REAR_WHEEL, attachY: REAR_ATTACH_Y },
  ],
  suspension: {
    suspensionStiffness: 55,
    suspensionRestLength: 0.08,
    maxSuspensionTravel: 0.28,
    rollingResistance: 0.014,
    frictionSlip: 1.15,
    dampingRelaxation: 3.6,
    dampingCompression: 2.8,
    rollInfluence: 0.25,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'v8',
  enginePowerHp: 680,
  peakTorqueNm: 770,
  peakTorqueRpm: 3000,
  idleRpm: 900,
  redlineRpm: 8000,
  turbo: { boostBar: 1.4, spoolRpm: 2800, lagS: 0.35 }, // bar, full-boost rpm, spool lag (s)
  launchRpm: 4000,
  gearRatios: [3.13, 2.1, 1.56, 1.22, 1.0, 0.85, 0.7],
  finalDriveRatio: 3.6,
  reverseRatio: 2.7,
  shiftDurationS: 0.12,
  brakeForce: 260,
  tractionControl: true,
  mass: 1350,
  fuelTankL: 80,
  radiator: 1.2,
  coolantL: 15,
  backfire: 0.6, // 0 no exhaust flame pops .. 1 full
  exhaustTips: [-0.12, 0.12].map((x) => ({ pos: [x, -0.16, -2.2] })),
  steerSpeedD: 0.007,
  maxSteerAt0: 0.65,
  maxSteerAt100: 0.35,
  dragProfile: { front: 0.6, side: 2.2, rear: 1.0 },
};
