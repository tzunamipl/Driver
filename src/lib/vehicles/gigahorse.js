import { wheelRadiusOf } from '../car/wheelMesh.js';
import { buildBody } from './geometry/gigahorse.js';

const FRONT_WHEEL = { rimSize: 20, tyre: 395, profile: 85 };
const REAR_WHEEL = { rimSize: 38, tyre: 650, profile: 65 };
const ATTACH_Y = -0.2;
// The tractor tyres' mounts sit higher by their extra radius so the bodies ride level.
const REAR_RADIUS_GAIN = wheelRadiusOf(REAR_WHEEL) - wheelRadiusOf(FRONT_WHEEL);

// Immortan Joe's Gigahorse: two stacked '59 Cadillac de Villes, twin
// supercharged big-block V8s, rear drive through giant tractor tyres.
export default {
  id: 'gigahorse',
  name: 'Gigahorse',
  category: 'fury-road',
  defaultColor: 0x15120f,
  rimColor: 0x2a2724,
  gloss: 0.8,
  buildBody,
  ...FRONT_WHEEL,
  axles: [
    { z: 2.0, halfTrack: 0.98, steer: true },
    { z: -2.0, halfTrack: 1.33, driven: true, wheel: REAR_WHEEL, attachY: ATTACH_Y + REAR_RADIUS_GAIN },
  ],
  wheelAttachY: ATTACH_Y,
  suspension: {
    suspensionStiffness: 22,
    suspensionRestLength: 0.45,
    maxSuspensionTravel: 0.35,
    rollingResistance: 0.025,
    frictionSlip: 1.5,
    dampingRelaxation: 3.4,
    dampingCompression: 2.4,
    rollInfluence: 0.12,
    pitchInfluence: 0.5,
  },
  suspensionForceG: 9,
  engine: 'v8',
  enginePowerHp: 1500,
  peakTorqueNm: 2400,
  peakTorqueRpm: 3500,
  idleRpm: 800,
  redlineRpm: 6000,
  gearRatios: [3.0, 2.0, 1.45, 1.1],
  finalDriveRatio: 7.0,
  reverseRatio: 3.0,
  shiftDurationS: 0.6,
  engineInertia: 1.2,
  brakeForce: 220,
  mass: 4000,
  steerSpeedD: 0.006,
  maxSteerAt0: 0.5,
  maxSteerAt100: 0.15,
  dragProfile: { front: 3.8, side: 10, rear: 4.2 },
  resetLift: 2,
  cameraScale: 1.0,
  cameraMounts: { hood: { offset: [0, 1.5, -0.2], lookAtOffset: [0, 1.3, 14] } },
  proxyBox: [3.3, 2.4, 6.0, 0.1],
};
