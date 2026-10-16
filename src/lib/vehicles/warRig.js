import { buildBody, buildTrailer } from './geometry/warRig.js';

// The War Rig: 6x6 tractor (steered front, dual-tyred rear tandem, all
// driven) with twin blown V8s, towing an articulated guzzoline tanker. The
// trailer hangs off the fifth wheel at `hitch` (tractor-local) by its
// `kingpin` (trailer-local); tyre/suspension fields it leaves out come from
// the tractor.
export default {
  id: 'war-rig',
  name: 'War Rig',
  category: 'fury-road',
  defaultColor: 0x1f1c1a,
  rimColor: 0x3a2c22,
  buildBody,
  rimSize: 22.5,
  tyre: 315,
  profile: 80,
  axles: [
    { z: 3.0, halfTrack: 1.0, steer: true, driven: true },
    { z: -1.6, halfTrack: 0.95, dual: true, driven: true },
    { z: -3.0, halfTrack: 0.95, dual: true, driven: true },
  ],
  wheelAttachY: -0.2,
  suspension: {
    suspensionStiffness: 24,
    suspensionRestLength: 0.45,
    maxSuspensionTravel: 0.3,
    rollingResistance: 0.018,
    frictionSlip: 1.4,
    dampingRelaxation: 3.4,
    dampingCompression: 2.5,
    rollInfluence: 0.15,
    pitchInfluence: 0.5,
  },
  suspensionForceG: 8,
  engine: 'v8',
  enginePowerHp: 1300,
  peakTorqueNm: 3800,
  peakTorqueRpm: 2800,
  idleRpm: 700,
  redlineRpm: 4800,
  gearRatios: [4.4, 2.6, 1.7, 1.25, 1.0, 0.82],
  finalDriveRatio: 6.0,
  reverseRatio: 4.2,
  shiftDurationS: 1.0,
  engineInertia: 1.5,
  brakeForce: 200,
  mass: 11000,
  steerSpeedD: 0.006,
  maxSteerAt0: 0.55,
  maxSteerAt100: 0.1,
  dragProfile: { front: 6.5, side: 18, rear: 7 },
  trailer: {
    buildBody: buildTrailer,
    mass: 9000,
    hitch: [0, 0.45, -2.2],
    kingpin: [0, 0.4, 4.2],
    axles: [
      { z: -2.6, halfTrack: 0.95, dual: true },
      { z: -4.0, halfTrack: 0.95, dual: true },
    ],
    wheelAttachY: -0.2,
    dragProfile: { front: 1.5, side: 24, rear: 6 },
  },
  resetLift: 2,
  cameraScale: 1.2,
  cameraMounts: { hood: { offset: [0, 1.75, 1.0], lookAtOffset: [0, 1.5, 14] } },
  proxyBox: [2.6, 2.6, 8.6, 0.3],
};
