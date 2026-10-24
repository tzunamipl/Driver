import { carAxles } from '../car/axles.js';
import { buildBody } from './geometry/levorg.js';

export default {
  id: 'levorg',
  name: 'Levorg',
  category: 'cars',
  defaultColor: 0xa9adb3, // silver
  rimColor: 0xcda434,
  buildBody,
  wheelRadius: 0.4,
  rimSize: 18,
  tyre: 225,
  profile: 35,
  suspension: {
    suspensionStiffness: 35,
    suspensionRestLength: 0.05,
    maxSuspensionTravel: 0.30,
    rollingResistance: 0.015,
    frictionSlip: 1.0,
    dampingRelaxation: 6.87,
    dampingCompression: 4.95,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 8,
  engine: 'v4',
  enginePowerHp: 172,
  peakTorqueNm: 250,
  peakTorqueRpm: 3500,
  idleRpm: 900,
  redlineRpm: 6000,
  // Small twin-scroll: early, soft boost.
  turbo: { boostBar: 0.9, spoolRpm: 2000, lagS: 0.4 }, // bar, full-boost rpm, spool lag (s)
  // TR580 range 3.58-0.57; upper steps spread evenly to the tallest ratio.
  gearRatios: [3.56, 2.255, 1.655, 1.201, 0.92, 0.71, 0.57],
  finalDriveRatio: 3.9,
  reverseRatio: 3.636,
  automaticGearbox: true, // CVT with stepped ratios
  shiftDurationS: 0.5,
  brakeForce: 170,
  tractionControl: true,
  mass: 1500,
  fuelTankL: 60,
  radiator: 1.0,
  coolantL: 7,
  steerSpeedD: 0.005,
  maxSteerAt0: 0.5,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.70, side: 3.4, rear: 1.2 },
  axles: carAxles('awd'),
};
