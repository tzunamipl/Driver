import { buildBody } from './geometry/htv.js';

// HTV (heavy tactical vehicle): 8x8, the two front axles steer (the second one less,
// from the shared turn centre over the rear tandem), 16.00R20 super singles,
// Detroit Diesel 8V92TA through a 6-speed Allison automatic.
export default {
  id: 'C012', // display name in ./names.js
  category: 'trucks',
  defaultColor: 0x4b5320, // olive drab
  rimColor: 0x2f3324,
  rims: { default: 'steel8' }, // car/rims.js, per tyre compound group
  buildBody,
  gloss: 0.15,
  rimSize: 20,
  tyre: 406,
  profile: 90,
  tyreCompound: 'allTerrain', // tyres/compounds.js
  axles: [
    { z: 3.4, halfTrack: 1.0, steer: true, driven: true },
    { z: 1.9, halfTrack: 1.0, steer: true, driven: true },
    { z: -3.0, halfTrack: 1.0, driven: true },
    { z: -4.5, halfTrack: 1.0, driven: true },
  ],
  // Small, tucked-up nose/tail contacts instead of the auto-fitted corner
  // spheres: ~40 deg approach, the rear tyres themselves set departure.
  groundSpheres: [
    { z: 4.7, y: 0.3, radius: 0.4 },
    { z: -4.8, y: 0.35, radius: 0.35 },
  ],
  wheelAttachY: -0.2,
  suspension: {
    suspensionStiffness: 22,
    suspensionRestLength: 0.45,
    maxSuspensionTravel: 0.3,
    rollingResistance: 0.02,
    frictionSlip: 1.0,
    dampingRelaxation: 2.3,
    dampingCompression: 1.4,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'v6d',
  exhaustTips: [{ pos: [-0.95, 2.1, 2.0], dir: [0, 1, 0] }], // stack top
  enginePowerHp: 500,
  peakTorqueNm: 2000,
  peakTorqueRpm: 1400,
  idleRpm: 650,
  redlineRpm: 2300,
  turbo: { boostBar: 1.5, spoolRpm: 1200, lagS: 1.0 }, // bar, full-boost rpm, spool lag (s)
  gearRatios: [6, 4.7, 2.21, 1.53, 1.0, 0.76, 0.67],
  finalDriveRatio: 7.3,
  reverseRatio: 4.8,
  shiftDurationS: 0.9,
  engineInertia: 2.5,
  brakeForce: 220,
  brakes: { front: { discMm: 430, vented: true }, rear: { discMm: 430, vented: true } },
  mass: 17000,
  fuelTankL: 590,
  radiator: 1.3, // military spec, sized for desert heat
  coolantL: 50,
  fuelType: 'diesel',
  steerSpeedD: 0.007,
  maxSteerAt0: 1.00,
  maxSteerAt100: 0.12,
  dragProfile: { front: 5.7, side: 22, rear: 8 },
  resetLift: 2,
  cameraScale: 1.1,
  cameraMounts: { hood: { offset: [0, 2.1, 4.1], lookAtOffset: [0, 1.8, 14] } },
  proxyBox: [2.44, 2.6, 10.2, 0],
};
