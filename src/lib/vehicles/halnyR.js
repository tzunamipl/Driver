import { carAxles } from '../car/axles.js';
import { buildRallyBody } from './geometry/halny.js';

// Halny R: front-drive rally kit car on the Halny shell. High-revving 2.0
// 16V with 220 hp, 6-speed sequential, gravel 195/65 R15, long-travel dampers.
export default {
  id: 'C025', // display name in ./names.js
  category: 'rally',
  defaultColor: 0xf4f4f2, // white
  rimColor: 0xd0d2d4,
  buildBody: buildRallyBody,
  rimSize: 15,
  tyre: 195,
  profile: 65,
  tyreCompound: 'gravelHard', // tyres/compounds.js
  axles: carAxles('fwd', 0.79),
  suspension: {
    suspensionStiffness: 44,
    suspensionRestLength: 0.15,
    maxSuspensionTravel: 0.5,
    rollingResistance: 0.015,
    frictionSlip: 1.1,
    dampingRelaxation: 5.0,
    dampingCompression: 3.5,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'r4na',
  enginePowerHp: 220,
  peakTorqueNm: 240,
  peakTorqueRpm: 6000,
  idleRpm: 1100,
  redlineRpm: 8500,
  launchRpm: 6000,
  gearRatios: [3.0, 2.2, 1.73, 1.4, 1.18, 1.0],
  finalDriveRatio: 4.7,
  reverseRatio: 3.3,
  shiftDurationS: 0.2,
  brakeForce: 190,
  abs: false,
  mass: 1050,
  fuelTankL: 60,
  radiator: 1.3,
  coolantL: 6.5,
  backfire: 0.5, // 0 no exhaust flame pops .. 1 full
  exhaustTips: [{ pos: [0.5, -0.3, -2.06] }],
  steerSpeedD: 0.007,
  maxSteerAt0: 0.75,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.75, side: 3.2, rear: 1.2 },
};
