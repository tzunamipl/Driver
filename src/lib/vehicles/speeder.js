import { carAxles } from '../car/axles.js';
import { buildBody } from './geometry/speeder.js';

export default {
  id: 'C007', // display name in ./names.js
  category: 'dumb',
  defaultColor: 0x1c1c1c, // black
  rimColor: 0xFF0000,
  buildBody,
  rimSize: 20,
  tyre: 355,
  profile: 15,
  tyreCompound: 'slickHard', // tyres/compounds.js
  suspension: {
    suspensionStiffness: 100,
    suspensionRestLength: 0.0,
    maxSuspensionTravel: 0.04,
    rollingResistance: 0.015,
    frictionSlip: 1.2,
    dampingRelaxation: 8.87,
    dampingCompression: 5.95,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'v6',
  enginePowerHp: 2000,
  peakTorqueNm: 4300,
  peakTorqueRpm: 6000,
  idleRpm: 1200,
  redlineRpm: 8000,
  gearRatios: [15, 8, 4, 2, 1, 0.5, 0.25, 0.15],
  finalDriveRatio: 3,
  reverseRatio: 6,
  automaticGearbox: true, // arcade rig: automatic only
  shiftDurationS: 0.1,
  brakeForce: 400,
  mass: 1500,
  fuelTankL: 70,
  radiator: 1.5,
  coolantL: 20,
  backfire: 1, // 0 no exhaust flame pops .. 1 full
  exhaustTips: [-1, 1].map((sx) => ({ pos: [sx * 0.65, -0.35, -0.8] })),
  steerSpeedD: 0.005,
  maxSteerAt0: 0.5,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.75, side: 2.0, rear: 1.2 },
  axles: carAxles('rwd'),
};
