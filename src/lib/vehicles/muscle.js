import { buildBody, AXLES_Z } from './geometry/muscle.js';

// Muscle: late-60s big-block hardtop. 7.0 l V8 with 425 hp, 4-speed,
// live rear axle on soft, floaty springs with weak damping: dives, squats
// and leans hard, wallows over crests. 235/70 R15, drum-era brakes.
export default {
  id: 'C027', // display name in ./names.js
  category: 'cars',
  defaultColor: 0x8a1414, // deep red
  rimColor: 0xc8ccd2,
  rims: { default: 'spoke4' }, // car/rims.js, per tyre compound group
  buildBody,
  rimSize: 15,
  tyre: 235,
  profile: 70,
  axles: [
    { z: AXLES_Z[0], halfTrack: 0.8, steer: true },
    { z: AXLES_Z[1], halfTrack: 0.8, driven: true },
  ],
  suspension: {
    suspensionStiffness: 20,
    suspensionRestLength: 0.18,
    maxSuspensionTravel: 0.45,
    rollingResistance: 0.016,
    frictionSlip: 0.95,
    dampingRelaxation: 1.2,
    dampingCompression: 0.9,
    rollInfluence: 0.5, // more body roll than the usual 0.3
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'v8',
  enginePowerHp: 425,
  peakTorqueNm: 660,
  peakTorqueRpm: 3200,
  idleRpm: 700,
  redlineRpm: 5800,
  gearRatios: [2.52, 1.88, 1.46, 1.0],
  finalDriveRatio: 3.73,
  reverseRatio: 2.59,
  shiftDurationS: 0.6,
  brakeForce: 130,
  abs: false,
  mass: 1700,
  fuelTankL: 75,
  radiator: 0.95,
  coolantL: 17,
  backfire: 0.5, // 0 no exhaust flame pops .. 1 full
  exhaustTips: [-1, 1].map((sx) => ({ pos: [sx * 0.6, -0.44, -2.58] })),
  // Slow, vague steering box.
  steerSpeedD: 0.005,
  maxSteerAt0: 0.6,
  maxSteerAt100: 0.3,
  dragProfile: { front: 0.95, side: 3.0, rear: 1.35 },
};
