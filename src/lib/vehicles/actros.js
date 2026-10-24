import { buildBody } from './geometry/actros.js';
import { rangeGearbox } from '../engine.js';

// Mercedes-Benz Actros 4163 8x4 tipper: two steered front axles (the second
// one less, from the shared turn centre over the rear tandem), driven
// dual-tyred rear tandem, OM473 straight-six through a 12-speed PowerShift.
export default {
  id: 'actros-8x4',
  name: 'Actros 4163 8x4 Tipper',
  category: 'trucks',
  defaultColor: 0xf2f2f0,
  rimColor: 0xb8bcc0,
  buildBody,
  rimSize: 22.5,
  tyre: 315,
  profile: 80,
  axles: [
    { z: 3.5, halfTrack: 1.02, steer: true },
    { z: 1.5, halfTrack: 1.02, steer: true },
    { z: -2.3, halfTrack: 0.95, dual: true, driven: true },
    { z: -3.65, halfTrack: 0.95, dual: true, driven: true },
  ],
  wheelAttachY: -0.2,
  suspension: {
    suspensionStiffness: 26,
    suspensionRestLength: 0.45,
    maxSuspensionTravel: 0.3,
    rollingResistance: 0.014,
    frictionSlip: 1.0,
    dampingRelaxation: 3.4,
    dampingCompression: 2.5,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'v6d',
  enginePowerHp: 625,
  peakTorqueNm: 3000,
  peakTorqueRpm: 1100,
  idleRpm: 600,
  redlineRpm: 2000,
  // Big diesel turbo: strong but slow to build.
  turbo: { boostBar: 2.5, spoolRpm: 1000, lagS: 1.2 }, // bar, full-boost rpm, spool lag (s)
  // 4-speed main box x LO/MID/HI range stage, evenly stepped 14.9..1.0.
  ...rangeGearbox([2.09, 1.63, 1.28, 1.0], [7.14, 2.67, 1.0]),
  finalDriveRatio: 3.4,
  reverseRatio: 13.0,
  shiftDurationS: 0.5,
  engineInertia: 2.4,
  brakeForce: 240,
  tractionControl: true,
  mass: 13000, // empty
  fuelTankL: 400,
  radiator: 1.1,
  coolantL: 45,
  fuelType: 'diesel',
  steerSpeedD: 0.006,
  maxSteerAt0: 0.6,
  maxSteerAt100: 0.12,
  dragProfile: { front: 6.2, side: 22, rear: 7 },
  resetLift: 2,
  cameraScale: 1.1,
  cameraMounts: { hood: { offset: [0, 1.4, 4.4], lookAtOffset: [0, 1.2, 14] } },
  proxyBox: [2.55, 3.4, 9.8, 0],
};
