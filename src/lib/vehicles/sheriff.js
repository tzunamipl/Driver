import { buildBody, AXLES_Z } from './geometry/sheriff.js';
import { rangeGearbox } from '../engine.js';

// Sheriff: full-size pickup, slightly lifted, 5.7 l V8 with 345 hp, 4-speed with a
// low range, four-wheel drive, 265/70 R17 all-terrains, heavy and soft.
export default {
  id: 'C034', // display name in ./names.js
  category: 'cars',
  defaultColor: 0x1d2a3a, // navy
  rimColor: 0xc8ccd2,
  rims: { default: 'steel8', tarmac: 'spoke5' }, // car/rims.js, per tyre compound group
  gloss: 0.6,
  buildBody,
  rimSize: 17,
  tyre: 265,
  profile: 70,
  tyreCompound: 'allTerrain', // tyres/compounds.js
  axles: [
    { z: AXLES_Z[0], halfTrack: 0.84, steer: true, driven: true },
    { z: AXLES_Z[1], halfTrack: 0.84, driven: true },
  ],
  // Tucked-up nose/tail contacts for approach and departure angles.
  groundSpheres: [
    { z: 2.4, y: -0.1, radius: 0.28 },
    { z: -2.4, y: -0.1, radius: 0.28 },
  ],
  wheelAttachY: -0.2,
  suspension: {
    suspensionStiffness: 28,
    suspensionRestLength: 0.3, // lifted
    maxSuspensionTravel: 0.5,
    rollingResistance: 0.017,
    frictionSlip: 1.0,
    dampingRelaxation: 2.4,
    dampingCompression: 1.7,
    rollInfluence: 0.35,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 9,
  engine: 'v8',
  enginePowerHp: 345,
  peakTorqueNm: 510,
  peakTorqueRpm: 3800,
  idleRpm: 650,
  redlineRpm: 5800,
  // 4-speed x LO/HI transfer case.
  ...rangeGearbox([3.06, 1.63, 1.0, 0.7], [2.72, 1.0]),
  finalDriveRatio: 3.55,
  reverseRatio: 2.3,
  shiftDurationS: 0.6,
  brakeForce: 190,
  brakes: { front: { discMm: 330, vented: true }, rear: { discMm: 300 } },
  mass: 2350,
  fuelTankL: 98,
  radiator: 1.1,
  coolantL: 15,
  backfire: 0.1, // 0 no exhaust flame pops .. 1 full
  exhaustTips: [{ pos: [0.7, -0.45, -2.8] }],
  steerSpeedD: 0.007,
  maxSteerAt0: 0.65,
  maxSteerAt100: 0.3,
  dragProfile: { front: 1.2, side: 4.0, rear: 1.6 },
};
