import { buildBody, AXLE_Z } from './geometry/cinquecento.js';

// Fiat Cinquecento 900 i.e. (1992): 3.2 m city box, 0.9 OHV four with
// 41 hp, 4-speed, 145/70 R13, 2.2 m wheelbase on a narrow track.
export default {
  id: 'cinquecento',
  name: 'Cinquecento',
  category: 'cars',
  defaultColor: 0xb3141c, // Rosso Corsa-ish solid red
  rimColor: 0x9a9ea3,
  gloss: 0.55,
  buildBody,
  rimSize: 13,
  tyre: 145,
  profile: 70,
  axles: [
    { z: AXLE_Z, halfTrack: 0.64, steer: true, driven: true },
    { z: -AXLE_Z, halfTrack: 0.64 },
  ],
  suspension: {
    suspensionStiffness: 26,
    suspensionRestLength: 0.08,
    maxSuspensionTravel: 0.35,
    rollingResistance: 0.016,
    frictionSlip: 0.95,
    dampingRelaxation: 3.5,
    dampingCompression: 1.9,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'r4na',
  enginePowerHp: 41,
  peakTorqueNm: 65,
  peakTorqueRpm: 3250,
  idleRpm: 850,
  redlineRpm: 6000,
  gearRatios: [3.909, 2.158, 1.345, 0.974],
  finalDriveRatio: 4.462,
  reverseRatio: 3.818,
  shiftDurationS: 0.8,
  brakeForce: 90,
  abs: false,
  mass: 710,
  fuelTankL: 35,
  radiator: 0.9, // cooling capacity, 1 = typical for the engine power (engineHeat.js); small radiator
  coolantL: 4.5,
  steerSpeedD: 0.005,
  maxSteerAt0: 0.55,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.60, side: 2.6, rear: 1.0 },
};
