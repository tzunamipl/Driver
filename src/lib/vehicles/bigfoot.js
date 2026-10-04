// Vehicle definition: "Bigfoot" monster truck - a boxy pickup cab + bed,
// roll cage, flame decals on the hood, and dramatically larger wheels than
// every other vehicle (see wheelRadius below, read by lib/car.js's
// createCar/createRemoteCar). Self-contained visuals only, same shape as
// every other descriptor (see ./gc8.js for the baseline) so it slots into
// the shared wheeled-car rig for free - the only things that make it feel
// like a monster truck instead of a reskinned sedan are its three physics
// overrides below (wheelRadius, suspension, enginePowerHp), all read
// generically by lib/car.js/app/input.js.

import * as THREE from 'three';

// === Tunable parameters (read generically by lib/car.js/app/input.js -
// see the matching descriptor fields at the bottom of this file) ===
// Keeping every physics/power knob for this vehicle up here in one place,
// instead of scattered through the body-geometry code below, so retuning
// it doesn't mean hunting through mesh-building boilerplate.

// Oversized wheels (baseline rally car is 0.4) - still a hallmark of a
// monster truck, but toned down from an earlier, comically huge 1.1 so
// the truck doesn't look like it's riding on tractor tires.
const WHEEL_RADIUS = 0.75;
// Soft, longer-travel suspension than the baseline rally car (so it can
// soak up monster-truck-size drops/jumps without bottoming out) but still
// proportioned like an actual suspension rather than most of a meter of
// travel. restLength/maxTravel scale down with the smaller WHEEL_RADIUS
// above (same restLength:radius and travel:restLength ratios as before),
// keeping the suspension proportioned to the truck's new, smaller tires
// instead of floating them absurdly high.
const SUSPENSION = {
  // Stiffness 10 sagged ~0.245m under its own resting weight (same
  // static-sag math as the baseline car, independent of mass) - stiffer
  // 20 halves that to a more realistic ~0.12m while staying softer than
  // the baseline rally car's stiffness 35, since a monster truck's
  // suspension is still meant to be noticeably softer/longer-travel.
  // Damping scaled up by the same sqrt(stiffness) ratio to preserve the
  // original damping ratio/settle behavior. (Sag depends only on
  // stiffness/mass, not restLength/radius, so this didn't need to change
  // when the wheels got smaller.)
  suspensionStiffness: 20,
  suspensionRestLength: 0.75,
  maxSuspensionTravel: 0.4,
  // Knobby, oversized off-road tyres deform/scrub more than the baseline
  // rally car's road tyres, so they have noticeably higher rolling
  // resistance at any speed (car.js's rollingResistance default is 0.015)
  // - this is the low-speed base value; it still grows with speed the
  // same way via wheeledVehicle.js's rollingResistanceSpeedFactor default.
  rollingResistance: 0.03,
  // Knobby off-road tyres grip dry tarmac less confidently than the
  // baseline rally car's road tyres (car.js's frictionSlip default is 1.6)
  // - lower, so this truck wheelspins a bit more readily under its own
  // huge 600hp (thematically fitting for a monster truck) and slides even
  // more easily than the baseline car on a hard landing.
  frictionSlip: 1.3,
  // Scaled from the baseline rally car's (now less underdamped, see
  // car.js) 8.87/5.92 by the same sqrt(stiffness) ratio as before
  // (sqrt(20/35) ~= 0.756), to keep the same damping ratio/settle feel.
  dampingRelaxation: 6.71,
  dampingCompression: 4.48,
};
// How many g's of static per-wheel load this truck's suspension can push
// before car.js caps it (see DEFAULT_SUSPENSION_FORCE_G there) - raised
// from the baseline rally car's 8g since a monster truck is specifically
// built for huge jumps/landings and needs more headroom before its tyres
// run out of grip budget and slide instead.
const SUSPENSION_FORCE_G = 11;
// Twice the baseline rally car's engine rating (equivalent bhp - see
// lib/car.js's hpToEngineForce/DEFAULT_ENGINE_HP), as its own independent
// number rather than a multiplier on a shared global force constant.
const ENGINE_POWER_HP = 600;
// Chassis weight in kg - a monster truck's huge frame/wheels/roll cage
// make it noticeably heavier than the baseline rally car (lib/car.js's
// DEFAULT_CHASSIS_MASS), its own independent weight rating. Scaled 10x
// alongside the baseline car's mass bump (150kg -> 1500kg) to stay real-
// world-ish while keeping the same relative weight vs. the GC8.
const MASS = 2600;
// Heavier than the baseline rally car (see MASS above), so it needs
// proportionally stronger brakes (lib/car.js's DEFAULT_BRAKE_FORCE) to
// pull up in a comparable distance rather than needing much longer to
// stop just because it's carrying more weight. Scaled 10x alongside mass.
const BRAKE_FORCE = 52000;
// See lib/airDrag.js - a tall, boxy truck is draggy from every angle
// (unlike the GC8's tapered nose), especially broadside-on. Raised
// substantially higher than the GC8's multipliers (not just proportioned
// the same as before airDrag.js's base-coefficient rebalance) - this
// truck's double engine force would otherwise let it out-top-speed the
// much more slippery GC8, when a real monster truck's huge frontal area/
// open wheel wells/knobby tires mean it tops out well below a rally car
// despite having far more power.
const DRAG_PROFILE = { front: 4.6, side: 9.9, rear: 5.7 };
// Speed-sensitive steering lock (radians, see app/input.js's effective-
// steer lerp between these two): how far the front wheels turn at a dead
// stop (maxSteerAt0) versus at 100 km/h (maxSteerAt100) and above. This
// truck's tall, top-heavy chassis (see MASS/SUSPENSION above) is far more
// flip-prone on a sudden hard turn at speed than the baseline rally car,
// so its highway-speed lock is cut down even further - this truck's own
// independent rating, same pattern as ENGINE_POWER_HP/BRAKE_FORCE.
const MAX_STEER_AT_0 = 0.5;
const MAX_STEER_AT_100 = 0.12;

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
  mass: MASS,
  maxSteerAt0: MAX_STEER_AT_0,
  maxSteerAt100: MAX_STEER_AT_100,
  brakeForce: BRAKE_FORCE,
  dragProfile: DRAG_PROFILE,
};
