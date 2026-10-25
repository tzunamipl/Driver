import { buildBody, AXLES_Z } from './geometry/spring.js';

// Spring: plain 2.0 l rear-drive saloon (150 hp, 5-speed) on tall, soft
// springs with next to no damping: it bounces and wallows on everything.
export default {
  id: 'C022', // display name in ./names.js
  category: 'dumb',
  defaultColor: 0x3f8f5a, // green
  rimColor: 0xb8bcc2,
  gloss: 0.5,
  buildBody,
  rimSize: 15,
  tyre: 195,
  profile: 65,
  axles: [
    { z: AXLES_Z[0], halfTrack: 0.75, steer: true },
    { z: AXLES_Z[1], halfTrack: 0.75, driven: true },
  ],
  suspension: {
    suspensionStiffness: 28,
    suspensionRestLength: 0.2,
    maxSuspensionTravel: 0.5,
    rollingResistance: 0.015,
    frictionSlip: 1.0,
    dampingRelaxation: 0.12,
    dampingCompression: 0.08,
    rollInfluence: 0.3,
    pitchInfluence: 1.0,
  },
  suspensionForceG: 10,
  engine: 'r4na',
  enginePowerHp: 150,
  peakTorqueNm: 190,
  peakTorqueRpm: 4200,
  idleRpm: 800,
  redlineRpm: 6200,
  gearRatios: [3.8, 2.2, 1.4, 1.0, 0.82],
  finalDriveRatio: 3.9,
  reverseRatio: 3.6,
  shiftDurationS: 0.6,
  brakeForce: 150,
  abs: false,
  mass: 1250,
  fuelTankL: 60,
  radiator: 1.0,
  coolantL: 7,
  steerSpeedD: 0.007,
  maxSteerAt0: 0.7,
  maxSteerAt100: 0.4,
  dragProfile: { front: 0.8, side: 2.8, rear: 1.2 },
};
