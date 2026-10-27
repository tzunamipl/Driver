import { buildBody, AXLES_Z } from './geometry/urban.js';

// Urban: kei-class family van, 660 cc three with 49 hp under the front seats,
// short 5-speed, rear drive, tall and narrow so it leans, 145/80 R12.
export default {
  id: 'C029', // display name in ./names.js
  category: 'cars',
  defaultColor: 0xe8ecef, // white
  rimColor: 0x9a9ea3,
  rims: { default: 'steel4' }, // car/rims.js, per tyre compound group
  gloss: 0.5,
  buildBody,
  rimSize: 12,
  tyre: 145,
  profile: 80,
  axles: [
    { z: AXLES_Z[0], halfTrack: 0.62, steer: true },
    { z: AXLES_Z[1], halfTrack: 0.62, driven: true },
  ],
  suspension: {
    suspensionStiffness: 30,
    suspensionRestLength: 0.1,
    maxSuspensionTravel: 0.3,
    rollingResistance: 0.016,
    frictionSlip: 0.95,
    dampingRelaxation: 2.6,
    dampingCompression: 1.6,
    rollInfluence: 0.42, // tall body leans more than the usual 0.3
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'r4na',
  enginePowerHp: 49,
  peakTorqueNm: 59,
  peakTorqueRpm: 3500,
  idleRpm: 900,
  redlineRpm: 7200,
  gearRatios: [3.77, 2.18, 1.43, 1.0, 0.79],
  finalDriveRatio: 5.3,
  reverseRatio: 3.6,
  shiftDurationS: 0.7,
  brakeForce: 90,
  brakes: { front: { discMm: 230 }, rear: { drumMm: 180 } },
  abs: false,
  mass: 950,
  fuelTankL: 37,
  radiator: 0.95,
  coolantL: 4,
  exhaustTips: [{ pos: [0.45, -0.45, -1.75] }],
  steerSpeedD: 0.007,
  maxSteerAt0: 0.75,
  maxSteerAt100: 0.4,
  dragProfile: { front: 1.1, side: 3.4, rear: 1.2 },
};
