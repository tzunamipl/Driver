import { buildBody, buildTrailer } from './geometry/scaniaR.js';
import { rangeGearbox } from '../engine.js';

// Scania R 500 4x2 tractor (rear-driven duals, 315/80 R22.5) pulling a
// tri-axle 13.6 m curtainsider on 385/65 R22.5 super singles - the standard
// European artic. The trailer hangs off the fifth wheel at `hitch`
// (tractor-local) by its `kingpin` (trailer-local).
export default {
  id: 'scania-r500',
  name: 'Scania R500 + Curtainsider',
  category: 'trucks',
  defaultColor: 0xb3131b,
  rimColor: 0xb8bcc0,
  buildBody,
  rimSize: 22.5,
  tyre: 315,
  profile: 80,
  axles: [
    { z: 2.0, halfTrack: 1.02, steer: true },
    { z: -1.8, halfTrack: 0.95, dual: true, driven: true },
  ],
  wheelAttachY: -0.2,
  suspension: {
    suspensionStiffness: 24,
    suspensionRestLength: 0.45,
    maxSuspensionTravel: 0.3,
    rollingResistance: 0.012,
    frictionSlip: 1.0,
    dampingRelaxation: 3.4,
    dampingCompression: 2.5,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'v6d',
  enginePowerHp: 500,
  peakTorqueNm: 2550,
  peakTorqueRpm: 1100,
  idleRpm: 600,
  redlineRpm: 2100,
  // Big diesel turbo: strong but slow to build.
  turbo: { boostBar: 2.3, spoolRpm: 1000, lagS: 1.1 }, // bar, full-boost rpm, spool lag (s)
  // 3-speed main box (like the GRS905 base box) x LO/MID/HI range stage, overdrive top.
  ...rangeGearbox([1.84, 1.36, 1.0], [5.0, 2.0, 0.8]),
  finalDriveRatio: 3.9,
  reverseRatio: 9.0,
  shiftDurationS: 0.8,
  engineInertia: 2.2,
  brakeForce: 200,
  tractionControl: true,
  mass: 7500,
  fuelTankL: 900,
  fuelType: 'diesel',
  steerSpeedD: 0.006,
  maxSteerAt0: 0.6,
  maxSteerAt100: 0.1,
  dragProfile: { front: 6.0, side: 16, rear: 5 },
  trailer: {
    buildBody: buildTrailer,
    mass: 7000, // empty
    gloss: 0, // fabric curtains
    hitch: [0, 0.15, -1.55],
    kingpin: [0, 0.15, 5.6],
    tyre: 385,
    profile: 65,
    axles: [
      { z: -1.9, halfTrack: 1.0 },
      { z: -3.2, halfTrack: 1.0 },
      { z: -4.5, halfTrack: 1.0 },
    ],
    wheelAttachY: -0.2,
    dragProfile: { front: 1.5, side: 38, rear: 7 },
  },
  resetLift: 2,
  cameraScale: 1.1,
  cameraMounts: { hood: { offset: [0, 1.65, 3.0], lookAtOffset: [0, 1.4, 14] } },
  proxyBox: [2.5, 3.6, 6.3, 0.3],
};
