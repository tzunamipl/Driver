import { carAxles } from '../car/axles.js';
import { buildBody } from './geometry/rally.js';

export default {
  id: 'rally',
  name: 'Rally',
  category: 'misc',
  defaultColor: 0xf2c230, // yellow
  rimColor: 0xF5F5F5,
  buildBody,
  rimSize: 17,
  tyre: 305,
  profile: 35,
  tyreCompound: 'semiSlickHard', // tyres/compounds.js
  suspension: {
    suspensionStiffness: 50,
    suspensionRestLength: 0.2,
    maxSuspensionTravel: 0.6,
    rollingResistance: 0.015,
    frictionSlip: 1.1,
    dampingRelaxation: 9.87,
    dampingCompression: 7.95,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'r4',
  enginePowerHp: 1200,
  peakTorqueNm: 2800,
  peakTorqueRpm: 4500,
  idleRpm: 1200,
  redlineRpm: 6000,
  turbo: { boostBar: 2.0, spoolRpm: 3500, lagS: 0.35 }, // bar, full-boost rpm, spool lag (s)
  gearRatios: [4, 2, 1, 0.5, 0.25],
  finalDriveRatio: 2.88,
  reverseRatio: 3.636,
  automaticGearbox: true, // arcade rig: automatic only
  shiftDurationS: 0.2,
  brakeForce: 220,
  abs: false,
  mass: 1500,
  fuelTankL: 80,
  radiator: 1.3,
  coolantL: 12,
  backfire: 1, // 0 no exhaust flame pops .. 1 full
  exhaustTips: [{ pos: [0.5, -0.22, -2.02] }],
  steerSpeedD: 0.005,
  maxSteerAt0: 0.5,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.75, side: 2.0, rear: 1.2 },
  axles: carAxles('awd'),
};
