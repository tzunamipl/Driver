import { buildBody, AXLES_Z } from './geometry/hummel.js';

// Hummel: 7.5 t cab-over flatbed tow truck. 3.0 l turbo diesel four with
// 180 hp, 6-speed, rear-driven duals on 215/75 R17.5, deck empty.
export default {
  id: 'C033', // display name in ./names.js
  category: 'trucks',
  defaultColor: 0xf2b705, // breakdown yellow
  rimColor: 0xb8bcc0,
  rims: { default: 'truck' }, // car/rims.js, per tyre compound group
  buildBody,
  rimSize: 17.5,
  tyre: 215,
  profile: 75,
  axles: [
    { z: AXLES_Z[0], halfTrack: 0.9, steer: true },
    { z: AXLES_Z[1], halfTrack: 0.8, dual: true, driven: true },
  ],
  wheelAttachY: -0.2,
  suspension: {
    suspensionStiffness: 28,
    suspensionRestLength: 0.3,
    maxSuspensionTravel: 0.3,
    rollingResistance: 0.013,
    frictionSlip: 1.0,
    dampingRelaxation: 3.2,
    dampingCompression: 2.3,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'v6d',
  enginePowerHp: 180,
  peakTorqueNm: 600,
  peakTorqueRpm: 1400,
  idleRpm: 700,
  redlineRpm: 3500,
  turbo: { boostBar: 1.6, spoolRpm: 1300, lagS: 0.9 }, // bar, full-boost rpm, spool lag (s)
  gearRatios: [6.1, 3.6, 2.2, 1.4, 1.0, 0.79],
  finalDriveRatio: 4.3,
  reverseRatio: 5.6,
  shiftDurationS: 0.7,
  engineInertia: 1.2,
  brakeForce: 200,
  brakes: { front: { discMm: 375, vented: true }, rear: { drumMm: 360 } },
  mass: 4800, // empty
  fuelTankL: 120,
  fuelType: 'diesel',
  radiator: 1.1,
  coolantL: 16,
  backfire: 0, // 0 no exhaust flame pops .. 1 full
  exhaustTips: [{ pos: [-1.0, -0.55, 0.2] }],
  steerSpeedD: 0.007,
  maxSteerAt0: 0.75,
  maxSteerAt100: 0.18,
  dragProfile: { front: 3.6, side: 11, rear: 3.5 },
  resetLift: 1.6,
  cameraScale: 1.05,
  cameraMounts: { hood: { offset: [0, 1.25, 3.3], lookAtOffset: [0, 1.0, 14] } },
  proxyBox: [2.3, 2.6, 7.2, 0],
};
