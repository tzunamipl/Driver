// Vehicle definition: Subaru Impreza GC8 (90s WRX/STI rally style).
// Self-contained so this one vehicle can be reskinned/retuned without
// touching the shared rig (physics/wheels/interpolation) in lib/car.js or
// any other vehicle's file - see lib/vehicles/index.js for how these
// per-file descriptors get collected into the selectable roster.

import * as THREE from 'three';

// === Tunable parameters (read generically by lib/car.js/app/input.js -
// see the matching descriptor fields at the bottom of this file) ===
// Keeping every physics/power knob for this vehicle up here in one place,
// instead of scattered through the body-geometry code below, so retuning
// it doesn't mean hunting through mesh-building boilerplate.

// Baseline rally car engine rating (equivalent bhp - see lib/car.js's
// hpToEngineForce), independent of every other vehicle's own rating. Only
// used as a fallback flat force now that this car's real force comes from
// its torque curve/gearbox (ENGINE_* /GEAR_RATIOS/etc below, read by
// lib/engine.js) - see lib/car.js's FORCE_PER_HP for the *global*
// hp->force conversion still shared by any wheeled vehicle without one.
const ENGINE_POWER_HP = 211;
// Rpm-driven torque curve + 5-speed gearbox (lib/engine.js), standing in
// for a 90s turbocharged EJ20 flat-four like the real GC8 WRX/STI's -
// peak torque a bit lower in the rev range and the redline a bit higher
// than a big, lazy naturally-aspirated engine would have, reflecting a
// smaller turbo motor that needs to be kept spinning to make power.
const PEAK_TORQUE_NM = 350;
const PEAK_TORQUE_RPM = 4000;
const IDLE_RPM = 900;
const REDLINE_RPM = 7000;
// Real Subaru 5-speed close-ratio rally gearbox ratios (1st-5th) plus the
// WRX/STI's actual 4.111 final-drive and 3.636 reverse ratios - this
// car's symmetrical AWD (driveWheels below) already splits that output
// across all four tyres.
const GEAR_RATIOS = [3.454, 2.062, 1.481, 1.166, 0.916];
const FINAL_DRIVE_RATIO = 4.111;
const REVERSE_RATIO = 3.636;
// Braking force in Newtons - set explicitly here so its rating stays
// independent of other vehicles' (e.g. bigfoot.js's stronger brakes) like
// ENGINE_POWER_HP/MASS. Scaled 10x alongside MASS below to keep the same
// braking deceleration as before the mass bump (see MASS's comment).
const BRAKE_FORCE = 211;
// Chassis weight in kg - the baseline rally car's own independent weight
// rating. 1500kg matches a real rally-prepped car's curb weight (an
// earlier 150kg felt unrealistically light/floaty under the world's
// real-world gravity - see app/physicsSetup.js).
const MASS = 1300;
// See lib/airDrag.js - a real, tapered car nose cuts through the air more
// easily than its flat-ish tail (plus the roof spoiler kicking up a bit
// more turbulence reversing into the air), and its flank is by far the
// biggest cross-section of all three. These multipliers are unchanged
// from before airDrag.js's AIR_DRAG_BASE_COEFFICIENT rebalance (0.01 -> 4)
// - that rebalance was about restoring the *absolute* scale of drag to
// match this car's (also rebalanced) engine force, not about this car's
// relative front/side/rear shape, which didn't change.
const DRAG_PROFILE = { front: 0.85, side: 2.4, rear: 1.2 };
// Speed-sensitive steering lock (radians, see app/input.js's effective-
// steer lerp between these two): how far the front wheels turn at a dead
// stop (maxSteerAt0) versus at 100 km/h (maxSteerAt100) and above. A real
// rally car's rack isn't actually speed-sensitive, but full 0.5 rad lock
// at highway speed would snap the tail out, so this tapers down to a
// steadier, more planted amount of lock once up to speed - still this
// car's own independent rating, same pattern as ENGINE_POWER_HP/MASS.
const STEER_SPEED_D = 0.005
const MAX_STEER_AT_0 = 0.5;
const MAX_STEER_AT_100 = 0.4;

const WHEEL_RADIUS = 0.35;
const SUSPENSION_FORCE_G = 8;
const SUSPENSION = {
  suspensionStiffness: 45,
  suspensionRestLength: 0.4,
  maxSuspensionTravel: 0.2,
  rollingResistance: 0.015,
  frictionSlip: 1.6,
  dampingRelaxation: 8.87,
  dampingCompression: 5.95,
  rollInfluence: 0.07,
  pitchInfluence: 0.55,
};

const DEFAULT_BODY_COLOR = 0xffffff; // white

/**
 * Slants the top-front and top-back vertices of a BoxGeometry inward along Z
 * to create a tapered "greenhouse" shape (windshield/rear-window rake),
 * keeping everything low-poly (still just box triangles, no extra geometry).
 */
function taperCabinTop(geometry, frontInset, backInset) {
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (y > 0) {
      if (z > 0) pos.setZ(i, z - frontInset);
      else pos.setZ(i, z + backInset);
    }
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Builds a low-poly Subaru Impreza GC (90s WRX/STI rally-styled) body out of
 * primitive boxes/cylinders: boxy sedan shell, raked cabin greenhouse, hood
 * scoop, round rally fog lights + rectangular headlights, and the iconic
 * STI rear wing on struts. The group stands in for the chassis mesh, sized
 * to roughly match the physics chassis footprint. `color` is the painted
 * shell so a remote car can recolor without rebuilding geometry.
 */
function buildBody(chassisWidth, chassisLength, color = DEFAULT_BODY_COLOR) {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.45 });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x161616, metalness: 0.2, roughness: 0.8 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x141a20, metalness: 0.6, roughness: 0.15 });
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff3cf, emissive: 0x554417, roughness: 0.3 });
  const fogMat = new THREE.MeshStandardMaterial({ color: 0xffe28a, emissive: 0x7a5410, roughness: 0.3 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x7a0f0f, emissive: 0x3a0000, roughness: 0.4 });

  const parts = [];
  const add = (geometry, material, x, y, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parts.push(mesh);
    return mesh;
  };

  // Main lower body shell.
  add(new THREE.BoxGeometry(chassisWidth, 0.5, chassisLength * 0.9), bodyMat, 0, -0.3, 0);

  // Tapered cabin/greenhouse (windshield rake at front, rear-window rake at back).
  const cabinGeo = taperCabinTop(new THREE.BoxGeometry(chassisWidth * 0.83, 0.55, chassisLength * 0.5), 0.5, 0.35);
  add(cabinGeo, glassMat, 0, 0.175, -0.1);

  // Hood (protrudes slightly past the main shell toward the nose).
  add(new THREE.BoxGeometry(chassisWidth * 0.97, 0.12, chassisLength * 0.28), bodyMat, 0, 0.01, chassisLength * 0.36);

  // Front bumper/nose cap.
  add(new THREE.BoxGeometry(chassisWidth, 0.35, 0.25), trimMat, 0, -0.35, chassisLength * 0.475);

  // Rear trunk deck + bumper.
  add(new THREE.BoxGeometry(chassisWidth * 0.97, 0.15, chassisLength * 0.2), bodyMat, 0, -0.02, -chassisLength * 0.39);
  add(new THREE.BoxGeometry(chassisWidth, 0.3, 0.2), trimMat, 0, -0.35, -chassisLength * 0.4875);

  // Grille + rectangular headlights.
  add(new THREE.BoxGeometry(0.5, 0.15, 0.03), trimMat, 0, -0.15, chassisLength * 0.49);
  add(new THREE.BoxGeometry(0.35, 0.18, 0.05), lightMat, chassisWidth * 0.36, -0.1, chassisLength * 0.49);
  add(new THREE.BoxGeometry(0.35, 0.18, 0.05), lightMat, -chassisWidth * 0.36, -0.1, chassisLength * 0.49);

  // Round rally fog lights (Impreza GC trademark).
  const fogGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.06, 12);
  fogGeo.rotateX(Math.PI / 2);
  add(fogGeo, fogMat, chassisWidth * 0.28, -0.42, chassisLength * 0.5);
  add(fogGeo.clone(), fogMat, -chassisWidth * 0.28, -0.42, chassisLength * 0.5);

  // Taillights.
  add(new THREE.BoxGeometry(0.3, 0.15, 0.05), tailMat, chassisWidth * 0.42, 0, -chassisLength * 0.49);
  add(new THREE.BoxGeometry(0.3, 0.15, 0.05), tailMat, -chassisWidth * 0.42, 0, -chassisLength * 0.49);

  // Hood scoop (WRX icon).
  add(new THREE.BoxGeometry(0.45, 0.08, 0.4), trimMat, 0, 0.11, chassisLength * 0.325);

  // Side mirrors.
  add(new THREE.BoxGeometry(0.1, 0.08, 0.15), bodyMat, chassisWidth * 0.53, 0.15, chassisLength * 0.15);
  add(new THREE.BoxGeometry(0.1, 0.08, 0.15), bodyMat, -chassisWidth * 0.53, 0.15, chassisLength * 0.15);

  // Rear STI wing on struts.
  const strutGeo = new THREE.BoxGeometry(0.05, 0.35, 0.05);
  add(strutGeo, trimMat, chassisWidth * 0.36, 0.2, -chassisLength * 0.46);
  add(strutGeo.clone(), trimMat, -chassisWidth * 0.36, 0.2, -chassisLength * 0.46);
  add(new THREE.BoxGeometry(chassisWidth * 0.9, 0.05, 0.35), trimMat, 0, 0.38, -chassisLength * 0.46);

  parts.forEach((mesh) => group.add(mesh));
  return { group, bodyMat };
}

/**
 * Vehicle descriptor consumed by lib/vehicles/index.js's registry (and, via
 * that, lib/car.js's shared rig + the lobby's vehicle picker). `buildBody`
 * must return `{ group, bodyMat }`: a THREE.Group sized to roughly
 * chassisWidth x chassisLength, and the paintable shell material so a
 * remote car can recolor without rebuilding geometry.
 */
export default {
  id: 'gc8',
  name: 'GC8',
  category: 'cars',
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
  // All-wheel drive (see lib/car.js's driveWheels doc comment/app/input.js)
  // - matches the real GC8 WRX/STI's symmetrical AWD drivetrain, and puts
  // this car's power down through all four tyres instead of just the rear
  // pair, noticeably cutting down on wheelspin/oversteer under hard
  // acceleration (especially on looser surfaces - see
  // lib/surfaceCompounds.js) versus a rear-wheel-drive car with the same
  // enginePowerHp.
  driveWheels: [0, 1, 2, 3],
};
