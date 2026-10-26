import { buildBody, AXLES_Z } from './geometry/explorer.js';
import { rangeGearbox } from '../engine.js';

// Explorer: body-on-frame 4x4, 3.0 l turbo diesel with 190 hp, 5-speed
// with a low range, permanent four-wheel drive, 265/75 R16 all-terrains.
export default {
  id: 'C021', // display name in ./names.js
  category: 'cars',
  outsideTempGauge: true, // dash LCD: outside temperature
  defaultColor: 0x5a6248, // olive
  rimColor: 0x2c2c2c,
  rims: { default: 'steel6', tarmac: 'spoke5' }, // car/rims.js, per tyre compound group
  gloss: 0.3,
  buildBody,
  rimSize: 16,
  tyre: 265,
  profile: 75,
  tyreCompound: 'allTerrain', // tyres/compounds.js
  axles: [
    { z: AXLES_Z[0], halfTrack: 0.8, steer: true, driven: true },
    { z: AXLES_Z[1], halfTrack: 0.8, driven: true },
  ],
  // Tucked-up nose/tail contacts for approach and departure angles.
  groundSpheres: [
    { z: 1.9, y: -0.05, radius: 0.28 },
    { z: -1.8, y: -0.05, radius: 0.28 },
  ],
  wheelAttachY: -0.2,
  suspension: {
    suspensionStiffness: 26,
    suspensionRestLength: 0.25,
    maxSuspensionTravel: 0.55,
    rollingResistance: 0.018,
    frictionSlip: 1.0,
    dampingRelaxation: 2.6,
    dampingCompression: 1.8,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 9,
  engine: 'v6d',
  enginePowerHp: 190,
  peakTorqueNm: 450,
  peakTorqueRpm: 2000,
  idleRpm: 700,
  redlineRpm: 4400,
  turbo: { boostBar: 1.2, spoolRpm: 1800, lagS: 0.8 }, // bar, full-boost rpm, spool lag (s)
  // 5-speed x LO/HI transfer case.
  ...rangeGearbox([4.3, 2.5, 1.5, 1.0, 0.8], [2.5, 1.0]),
  finalDriveRatio: 3.9,
  reverseRatio: 4.0,
  shiftDurationS: 0.7,
  brakeForce: 170,
  mass: 2200,
  fuelTankL: 90,
  fuelType: 'diesel',
  radiator: 1.15,
  coolantL: 12,
  backfire: 0, // 0 no exhaust flame pops .. 1 full
  exhaustTips: [{ pos: [0.6, -0.36, -2.1] }],
  steerSpeedD: 0.007,
  maxSteerAt0: 0.75,
  maxSteerAt100: 0.3,
  dragProfile: { front: 1.1, side: 3.6, rear: 1.5 },
};
