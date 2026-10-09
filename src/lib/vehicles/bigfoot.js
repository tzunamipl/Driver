import * as THREE from 'three';

const ENGINE_POWER_HP = 800;
const PEAK_TORQUE_NM = 2000;
const PEAK_TORQUE_RPM = 3000;
const IDLE_RPM = 700;
const REDLINE_RPM = 5200;
const GEAR_RATIOS = [2.22, 1.62, 1.0];
const FINAL_DRIVE_RATIO = 6.17;
const REVERSE_RATIO = 1.82;
const MASS = 2600;
const BRAKE_FORCE = 160;
const DRAG_PROFILE = { front: 4.6, side: 9.9, rear: 5.7 };
const STEER_SPEED_D = 0.01
const MAX_STEER_AT_0 = 0.5;
const MAX_STEER_AT_100 = 0.12;

const WHEEL_RADIUS = 0.75;
const SUSPENSION_FORCE_G = 11;
const SUSPENSION = {
  suspensionStiffness: 15,
  suspensionRestLength: 0.85,
  maxSuspensionTravel: 0.6,
  rollingResistance: 0.03,
  frictionSlip: 1.3,
  dampingRelaxation: 2.71,
  dampingCompression: 0.48,
  rollInfluence: 0.11,
  pitchInfluence: 0.75,
};

const DEFAULT_BODY_COLOR = 0xcc1f1f; // classic monster-truck red

/**
 * Builds a low-poly monster-truck pickup out of primitive boxes/cylinders:
 * a high-riding boxy cab, open truck bed, chunky chrome bumpers, a roll
 * cage, and flame decals streaking back across the hood. The group stands
 * in for the chassis mesh, sized to roughly match the physics chassis
 * footprint (same as every other vehicle - see ./gc8.js). `color` is the
 * painted shell so a remote car can recolor without rebuilding geometry.
 */
function buildBody(chassisWidth, chassisLength, color = DEFAULT_BODY_COLOR) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.55 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, metalness: 0.2, roughness: 0.8 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, metalness: 0.9, roughness: 0.2 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x141a20, metalness: 0.6, roughness: 0.15 });
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff3cf, emissive: 0x554417, roughness: 0.3 });
  const flameMat = new THREE.MeshStandardMaterial({ color: 0xff9a1f, emissive: 0xff5a00, emissiveIntensity: 1.1, roughness: 0.35 });

  const parts = [];
  const add = (geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parts.push(mesh);
    return mesh;
  };

  // High-riding main chassis rail/frame - sits well above the (comparatively
  // tiny) stock chassis footprint since the huge wheels (see wheelRadius in
  // the descriptor below) push the whole truck much higher off the ground.
  add(new THREE.BoxGeometry(chassisWidth, 0.45, chassisLength * 0.95), trimMat, 0, -0.35, 0);

  // Cab (front half) - boxy, upright, high greenhouse.
  add(new THREE.BoxGeometry(chassisWidth * 0.92, 0.65, chassisLength * 0.42), bodyMat, 0, 0.2, chassisLength * 0.18);
  add(new THREE.BoxGeometry(chassisWidth * 0.8, 0.4, chassisLength * 0.34), glassMat, 0, 0.58, chassisLength * 0.17);

  // Open truck bed (rear half) - low side rails, flat floor.
  add(new THREE.BoxGeometry(chassisWidth * 0.92, 0.08, chassisLength * 0.4), bodyMat, 0, -0.08, -chassisLength * 0.27);
  add(new THREE.BoxGeometry(chassisWidth * 0.92, 0.3, 0.06), bodyMat, 0, 0.07, -chassisLength * 0.47);
  add(new THREE.BoxGeometry(0.06, 0.3, chassisLength * 0.4), bodyMat, chassisWidth * 0.46, 0.07, -chassisLength * 0.27);
  add(new THREE.BoxGeometry(0.06, 0.3, chassisLength * 0.4), bodyMat, -chassisWidth * 0.46, 0.07, -chassisLength * 0.27);

  // Hood + round headlights.
  add(new THREE.BoxGeometry(chassisWidth * 0.9, 0.18, chassisLength * 0.22), bodyMat, 0, -0.05, chassisLength * 0.42);
  const lightGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.08, 12);
  lightGeo.rotateX(Math.PI / 2);
  add(lightGeo, lightMat, chassisWidth * 0.32, -0.08, chassisLength * 0.5);
  add(lightGeo.clone(), lightMat, -chassisWidth * 0.32, -0.08, chassisLength * 0.5);

  // Flame decals streaking back from the headlights across the hood.
  add(new THREE.BoxGeometry(0.4, 0.02, chassisLength * 0.3), flameMat, chassisWidth * 0.22, 0.041, chassisLength * 0.32);
  add(new THREE.BoxGeometry(0.4, 0.02, chassisLength * 0.3), flameMat, -chassisWidth * 0.22, 0.041, chassisLength * 0.32);

  // Heavy chrome front/rear bumpers (classic monster-truck "tube" look).
  const bumperGeo = new THREE.CylinderGeometry(0.09, 0.09, chassisWidth * 1.05, 10);
  bumperGeo.rotateZ(Math.PI / 2);
  add(bumperGeo, chromeMat, 0, -0.42, chassisLength * 0.5);
  add(bumperGeo.clone(), chromeMat, 0, -0.42, -chassisLength * 0.5);

  // Roll cage over the cab.
  const cageGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.6, 8);
  for (const sx of [-1, 1]) {
    const bar = cageGeo.clone();
    add(bar, chromeMat, sx * chassisWidth * 0.4, 0.55, chassisLength * 0.02);
  }
  add(new THREE.BoxGeometry(chassisWidth * 0.82, 0.05, 0.05), chromeMat, 0, 0.85, chassisLength * 0.02);

  // Tall whip antenna + roof light bar, so it reads as a monster truck even
  // from a distance where the huge wheels are the only other tell.
  add(new THREE.BoxGeometry(0.3, 0.08, 0.12), lightMat, 0, 0.62, chassisLength * 0.3);

  parts.forEach((mesh) => group.add(mesh));
  return { group, bodyMat };
}

/**
 * Vehicle descriptor consumed by lib/vehicles/index.js's registry (and, via
 * that, lib/car.js's shared wheeled-car rig + the lobby's vehicle picker).
 * `wheelRadius`/`suspension`/`enginePowerHp` are read generically by
 * lib/car.js (createCar/createRemoteCar) and app/input.js - see the
 * tunable-parameters comments at the top of this file - so this one
 * descriptor is all it takes to make a truck that rides dramatically
 * higher, soaks up huge drops, and accelerates twice as hard as the
 * baseline rally car, with zero changes needed to the shared rig itself.
 */
export default {
  id: 'bigfoot',
  name: 'Bigfoot Monster Truck',
  category: 'misc',
  defaultColor: DEFAULT_BODY_COLOR,
  buildBody,
  wheelRadius: WHEEL_RADIUS,
  suspension: SUSPENSION,
  suspensionForceG: SUSPENSION_FORCE_G,
  enginePowerHp: ENGINE_POWER_HP,
  peakTorqueNm: PEAK_TORQUE_NM,
  peakTorqueRpm: PEAK_TORQUE_RPM,
  idleRpm: IDLE_RPM,
  redlineRpm: REDLINE_RPM,
  gearRatios: GEAR_RATIOS,
  finalDriveRatio: FINAL_DRIVE_RATIO,
  reverseRatio: REVERSE_RATIO,
  brakeForce: BRAKE_FORCE,
  mass: MASS,
  steerSpeedD: STEER_SPEED_D,
  maxSteerAt0: MAX_STEER_AT_0,
  maxSteerAt100: MAX_STEER_AT_100,
  dragProfile: DRAG_PROFILE,
};
