import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { getVehicle, DEFAULT_VEHICLE_ID } from './vehicles/index.js';
import { CHASSIS_MATERIAL, createNameTag } from './vehicleShared.js';
import { createChariotVehicle, createRemoteChariot } from './chariot.js';
import { applyAirDrag, DEFAULT_DRAG_PROFILE } from './airDrag.js';
import { createWheeledVehicle } from './wheeledVehicle.js';
import { findGroundY } from './terrain.js';

// Re-exported from vehicleShared.js (not defined here) so every existing
// `import { CHASSIS_MATERIAL } from './lib/car.js'` call site keeps
// working unchanged - see vehicleShared.js for why it had to move out of
// this file (lib/chariot.js, the hover-vehicle rig, needs it too, and
// importing it back from here would be circular).
export { CHASSIS_MATERIAL, createNameTag };

const DEFAULT_BODY_COLOR = 0xffffff; // white
const CHASSIS_WIDTH = 1.8;
const CHASSIS_HEIGHT = 0.6;
const CHASSIS_LENGTH = 4;
const WHEEL_RADIUS = 0.4;
// Chassis weight (kg), expressed per-vehicle (descriptor.mass - see
// lib/vehicles/gc8.js/bigfoot.js) the same way enginePowerHp/dragProfile
// already are, rather than every wheeled vehicle sharing one hardcoded
// mass - only applies if a descriptor omits its own value.
// 1500kg matches a real rally-prepped car's curb weight (a plain ~150kg
// figure made the chassis feel unrealistically light/floaty under the
// world's real-world gravity - see physicsSetup.js). Every other
// mass-dependent constant below (FORCE_PER_HP, DEFAULT_BRAKE_FORCE) - and
// each vehicle's own explicit mass/brakeForce/maxSuspensionForce - was
// scaled up by the same 10x factor so acceleration, braking, and
// suspension response all feel identical to before, just at a real mass.
const DEFAULT_CHASSIS_MASS = 1500; // baseline rally car's weight
// How long a reset's lift-back-upright takes to ease into place, instead of
// snapping there in a single instantaneous teleport.
const RESET_LIFT_DURATION_S = 0.6;
// Matches app/physicsSetup.js's world gravity magnitude - duplicated here
// (rather than imported) since it's only needed for the per-wheel static
// load estimate below, not for simulating gravity itself.
const GRAVITY = 9.82;
// How much harder than its own resting weight a wheel's suspension (and
// therefore its tyre's available grip - see wheeledVehicle.js's
// maxGrip = suspensionForce * dt * frictionSlip) is allowed to push,
// expressed as a multiple of static per-wheel load ("g" of load, not of
// chassis acceleration) rather than a flat absolute Newton figure -
// otherwise a flat cap either needs re-tuning every time a vehicle's mass
// changes (see DEFAULT_CHASSIS_MASS's history) or, left generous enough to
// never need retuning, ends up so high it never actually binds. That's
// exactly what was happening here: a hard sideways landing spikes the
// suspension's damping term (proportional to closing speed * mass) far
// above its steady-state load, and with the old flat ~270x-static cap
// that spike fed straight into maxGrip, giving the tyre enough one-frame
// grip budget to fully cancel a car's entire sideways momentum in a single
// step - reads as the car snapping instantly upright/straight on landing
// instead of sliding. Capping load at a realistic multiple of a wheel's
// own static share of the chassis weight means a landing hard enough to
// need more grip than that actually slides instead.
const DEFAULT_SUSPENSION_FORCE_G = 8;
const WHEELS_PER_VEHICLE = 4;

// Engine power, expressed per-vehicle as an equivalent "bhp" rating
// (descriptor.enginePowerHp - see lib/vehicles/gc8.js/bigfoot.js) and
// converted here to the raw engine force (Newtons) that
// RaycastVehicle.applyEngineForce actually expects. This is a simple,
// linear arcade conversion for game balance (not a real-world
// torque/gearing/speed curve) - the point is each car now carries its own
// independent power number instead of every car scaling off one shared
// global force constant.
// Scaled up 10x alongside DEFAULT_CHASSIS_MASS (150kg -> 1500kg) so
// force/mass - and therefore acceleration - stays exactly what it was
// before the mass bump.
const FORCE_PER_HP = 12;
const DEFAULT_ENGINE_HP = 100; // baseline rally car's rating
function hpToEngineForce(hp) {
  return hp * FORCE_PER_HP;
}

// Braking force (Newtons), expressed per-vehicle (descriptor.brakeForce -
// see lib/vehicles/gc8.js/bigfoot.js) the same way enginePowerHp/mass
// already are, rather than every wheeled vehicle sharing one hardcoded
// handbrake strength from config.js's BRAKE_FORCE - a heavier/more
// powerful vehicle (e.g. a monster truck) can carry its own stronger
// brakes instead of fighting the same braking force as the baseline car.
// Also scaled 10x alongside DEFAULT_CHASSIS_MASS (see above) to keep the
// same braking deceleration as before the mass bump.
const DEFAULT_BRAKE_FORCE = 30000; // baseline rally car's rating


/**
 * Returns the chassis' top-down footprint as an octagon tapered at the
 * nose and tail (full width at the doors, narrower at the front/rear
 * corners) - a much closer match to an actual car silhouette than a plain
 * rectangle, while staying convex (required for CANNON.ConvexPolyhedron).
 * Points are listed in the winding order buildCarHullPrism needs for
 * outward-facing face normals (verified against cannon-es's own
 * computeNormals - reversing this order flips every face inward).
 */
function buildCarHullPoints(chassisWidth, chassisLength) {
  const w = chassisWidth / 2;
  const l = chassisLength / 2;
  return [
    { x: -0.5 * w, z: l },
    { x: -w, z: 0.55 * l },
    { x: -w, z: -0.55 * l },
    { x: -0.5 * w, z: -l },
    { x: 0.5 * w, z: -l },
    { x: w, z: -0.55 * l },
    { x: w, z: 0.55 * l },
    { x: 0.5 * w, z: l },
  ];
}

/**
 * Builds a CANNON.ConvexPolyhedron prism (vertical walls + flat top/
 * bottom) from a convex top-down hull (see buildCarHullPoints), spanning
 * `-halfHeight..+halfHeight` in Y and centered on the shape's local
 * origin - i.e. the chassis body's own center, so it can be added to
 * chassisBody with no extra position offset. Vertex/face layout mirrors
 * buildings.js's buildFootprintPrism (interleaved bottom/top rings, side
 * quads, reversed top ring).
 */
function buildCarHullPrism(hull, halfHeight) {
  const n = hull.length;
  const vertices = [];
  const sideFaces = [];
  const bottomFace = [];
  const topFace = [];
  for (let i = 0; i < n; i++) {
    const p = hull[i];
    vertices.push(new CANNON.Vec3(p.x, -halfHeight, p.z));
    bottomFace.push(2 * i);
    vertices.push(new CANNON.Vec3(p.x, halfHeight, p.z));
    topFace.push(2 * i + 1);
    const j = (i + 1) % n;
    sideFaces.push([2 * i, 2 * i + 1, 2 * j + 1, 2 * j]);
  }
  const faces = [...sideFaces, bottomFace, topFace.slice().reverse()];
  return new CANNON.ConvexPolyhedron({ vertices, faces });
}

/**
 * Builds a two-tone low-poly rally wheel: a black tire cylinder plus a
 * smaller gold octagonal "rim" cylinder for a BBS-style mesh-wheel look.
 * Tire/rim thickness scales with `radius` (rather than a flat constant)
 * so a bigger-wheeled vehicle (e.g. lib/vehicles/bigfoot.js) reads as a
 * proportionally chunkier tire instead of a comparatively thin disc.
 */
function buildRallyWheel(radius, parent) {
  const group = new THREE.Group();
  const tireWidth = radius * 0.95;
  const rimWidth = tireWidth * 0.85;

  const tireGeo = new THREE.CylinderGeometry(radius, radius, tireWidth, 20);
  tireGeo.rotateZ(Math.PI / 2);
  const tire = new THREE.Mesh(tireGeo, new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 }));
  tire.castShadow = true;
  group.add(tire);

  const rimGeo = new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, rimWidth, 8);
  rimGeo.rotateZ(Math.PI / 2);
  const rim = new THREE.Mesh(rimGeo, new THREE.MeshStandardMaterial({ color: 0xcda434, metalness: 0.8, roughness: 0.35 }));
  rim.castShadow = true;
  group.add(rim);

  parent.add(group);
  return group;
}


/**
 * Creates a Cannon-es RaycastVehicle (suspension, wheel friction,
 * acceleration) for the physics body, plus the selected vehicle's
 * Three.js mesh (see lib/vehicles/index.js's registry - `vehicleId`
 * defaults to DEFAULT_VEHICLE_ID when omitted/unknown). The physics rig
 * (chassis shape, wheels, inertia tuning) is shared by every *wheeled*
 * vehicle kind for now - only the visible body mesh is swapped per
 * vehicle. Hover vehicles (descriptor.vehicleType === 'hover', e.g. the
 * Chariots of Fire pod racers) are built by a completely different rig
 * instead - see lib/chariot.js - since differential-thrust hovering has
 * nothing in common with wheel suspension/friction.
 */
export function createCar(
  world,
  THREE_scene,
  startPosition = new CANNON.Vec3(0, 1, 0),
  startQuaternion = new CANNON.Quaternion(0, 0, 0, 1),
  color = DEFAULT_BODY_COLOR,
  vehicleId = DEFAULT_VEHICLE_ID
) {
  const descriptor = getVehicle(vehicleId);
  if (descriptor.vehicleType === 'hover') {
    return createChariotVehicle(world, THREE_scene, startPosition, startQuaternion, color, descriptor);
  }

  // --- Chassis physics body ---
  const chassisWidth = CHASSIS_WIDTH;
  const chassisHeight = CHASSIS_HEIGHT;
  const chassisLength = CHASSIS_LENGTH;

  // cannon-es's narrowphase only implements Sphere<->Trimesh collision, not
  // Box/ConvexPolyhedron<->Trimesh (both unimplemented/commented out in
  // the library). Since the real-world terrain is a Trimesh, a body made
  // entirely of a car-shaped ConvexPolyhedron would never actually
  // collide with the ground - it'd only stay up via the wheels' raycasts,
  // and a hard crash/rollover would fall straight through. So the chassis
  // is a compound body with *two* kinds of shape, both on the same body
  // (cannon-es only filters collisions per-body, not per-shape, but a
  // body's shapes can freely mix types - narrowphase just runs whichever
  // pairwise check each shape-type combo supports):
  //   1. carHullPrism - a proper tapered car-outline prism (see below),
  //      giving accurate, actually-car-shaped collision against buildings
  //      and pedestrians (Sphere/ConvexPolyhedron<->ConvexPolyhedron are
  //      both implemented).
  //   2. A small sphere at each of the 8 bounding-box corners, purely as a
  //      ground-contact safety net for tumbles/rollovers - spheres are the
  //      only shape that actually collides with the terrain Trimesh.
  const carHullPoints = buildCarHullPoints(chassisWidth, chassisLength);
  const carHullPrism = buildCarHullPrism(carHullPoints, chassisHeight / 2);

  const hitboxRadius = Math.min(chassisWidth, chassisHeight) / 2 - 0.05;
  const chassisMass = descriptor.mass ?? DEFAULT_CHASSIS_MASS;
  const chassisBody = new CANNON.Body({ mass: chassisMass, material: CHASSIS_MATERIAL });
  chassisBody.addShape(carHullPrism);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        chassisBody.addShape(
          new CANNON.Sphere(hitboxRadius),
          new CANNON.Vec3(
            sx * (chassisWidth / 2 - hitboxRadius),
            sy * (chassisHeight / 2 - hitboxRadius),
            sz * (chassisLength / 2 - hitboxRadius)
          )
        );
      }
    }
  }
  chassisBody.position.copy(startPosition);
  chassisBody.quaternion.copy(startQuaternion);
  chassisBody.angularVelocity.set(0, 0, 0);

  // --- Vehicle ---
  // Built from scratch (lib/wheeledVehicle.js) rather than
  // CANNON.RaycastVehicle - see that file's header for why (full-travel
  // suspension raycasts, normal-aligned suspension force, and a proper
  // effective-mass friction solve with built-in pitch/roll lever-arm
  // reduction, instead of needing this file to patch cannon's vehicle
  // after the fact).
  const vehicle = createWheeledVehicle({
    chassisBody,
    indexRightAxis: 0,
    indexUpAxis: 1,
    indexForwardAxis: 2,
  });

  // Per-vehicle suspension/wheel-size tuning (see e.g. lib/vehicles/bigfoot.js
  // for a monster-truck-style override) - any key here overrides the rally-car
  // defaults below, letting one vehicle (bigger wheels, softer/longer-travel
  // suspension, etc) differ from the rest without forking the whole rig.
  const suspensionOverrides = descriptor.suspension ?? {};
  const wheelRadius = descriptor.wheelRadius ?? WHEEL_RADIUS;
  // See DEFAULT_SUSPENSION_FORCE_G above - this vehicle's own independent
  // "how many g's of load can the suspension push before it's capped"
  // rating (lib/vehicles/bigfoot.js raises it for its monster-truck-sized
  // jumps/landings), the same per-vehicle-overridable pattern as
  // mass/enginePowerHp/wheelRadius.
  const suspensionForceG = descriptor.suspensionForceG ?? DEFAULT_SUSPENSION_FORCE_G;
  const maxSuspensionForce = ((chassisMass * GRAVITY) / WHEELS_PER_VEHICLE) * suspensionForceG;

  const wheelOptions = {
    radius: wheelRadius,
    directionLocal: new CANNON.Vec3(0, -1, 0),
    // Stiffness of 10 let the chassis sag ~0.245m under its own resting
    // weight (g/(4*stiffness), independent of mass) - nearly half the rest
    // length, so the body visibly slumped down onto the springs at a
    // standstill. 35 brings static sag down to a realistic ~7cm. Damping
    // is scaled up by the same sqrt(stiffness) ratio to keep the same
    // damping ratio (same bounciness/settle behavior as before, just stiffer).
    suspensionStiffness: 35,
    suspensionRestLength: 0.55,
    // Tyre friction coefficient (mu, see wheeledVehicle.js's
    // maxGrip = suspensionForce * dt * frictionSlip) - 1.6 matches a
    // genuinely sticky tarmac rally tyre. The old value of 5 was an
    // unrealistic "super-glue" grip level (real tyres top out around
    // 1.3-1.8, even race slicks) that - combined with the old uncapped
    // suspension-force spikes on hard impacts (see maxSuspensionForce
    // above) - let a single frame's tyre grip budget fully cancel a car's
    // entire sideways momentum on landing, reading as an instant,
    // unrealistic snap back upright/straight instead of a visible slide.
    frictionSlip: 1.6,
    // Rolling resistance coefficient (Crr at low speed, see
    // wheeledVehicle.js) - the baseline rally car's road tyres on asphalt.
    // Per-vehicle descriptors (e.g. lib/vehicles/bigfoot.js's knobbier
    // off-road tyres) can raise or lower this independently via
    // descriptor.suspension, same as frictionSlip/suspensionStiffness
    // above. rollingResistanceSpeedFactor (how fast Crr grows with speed)
    // is likewise overridable but left at wheeledVehicle.js's default here
    // since road vs. off-road tyres differ mainly in their base Crr, not
    // how sharply it climbs with speed.
    rollingResistance: 0.015,
    // Damping ratio = damping / (2*sqrt(stiffness)); critical damping here
    // is 2*sqrt(35) ~= 11.83. The old values (2.62/3.74, ratios ~0.22/0.32)
    // were well under 1 (underdamped), so every bump/landing kept the
    // spring oscillating for a beat or two instead of settling - read as
    // the chassis feeling bouncy/springy on ground contact. Raised to
    // ratios ~0.75/0.5 (rebound damped harder than compression, same as a
    // real shock) so the suspension absorbs a hit and settles promptly
    // instead of bouncing back.
    dampingRelaxation: 8.87,
    dampingCompression: 5.92,
    // Derived from this vehicle's own mass/suspensionForceG above (see the
    // DEFAULT_SUSPENSION_FORCE_G comment) rather than a flat number, so it
    // scales automatically with chassisMass and stays a realistic cap
    // (instead of a huge flat ceiling that let hard-landing suspension
    // spikes translate into unrealistically sticky tyre grip).
    maxSuspensionForce,
    rollInfluence: 0.01,
    axleLocal: new CANNON.Vec3(-1, 0, 0),
    chassisConnectionPointLocal: new CANNON.Vec3(1, 0, 1),
    // Real suspension travel is a handful of inches, not most of a meter -
    // 0.95 (nearly 2x the wheel radius) let the wheels visibly telescope
    // in/out over every bump instead of staying close to the body like an
    // actual suspension. 0.35 keeps enough droop/compression to soak up
    // curbs and landings without the wheels looking like they're on
    // springs stretched way past the chassis. Needs to clear this
    // suspension's own static sag under the car's resting weight (now
    // ~0.07m at stiffness 35) with real headroom left over for bumps/
    // landings - anything too tight bottoms the springs out under nothing
    // more than the car's own weight and the resulting zero-compliance
    // corner destabilizes into a persistent, stuck-in-place lean.
    maxSuspensionTravel: 0.35,
    customSlidingRotationalSpeed: -30,
    useCustomSlidingRotationalSpeed: true,
    ...suspensionOverrides,
  };

  const axleWidth = chassisWidth / 2 - 0.1;
  const wheelFront = 1.3;
  const wheelBack = -1.3;
  // attach wheels at the chassis underside (not the center) for pitch/roll stability
  const wheelAttachY = -chassisHeight / 2;

  const wheelPositions = [
    new CANNON.Vec3(-axleWidth, wheelAttachY, wheelFront), // front-left
    new CANNON.Vec3(axleWidth, wheelAttachY, wheelFront), // front-right
    new CANNON.Vec3(-axleWidth, wheelAttachY, wheelBack), // rear-left
    new CANNON.Vec3(axleWidth, wheelAttachY, wheelBack), // rear-right
  ];

  wheelPositions.forEach((pos) => {
    vehicle.addWheel({ ...wheelOptions, chassisConnectionPointLocal: pos });
  });

  vehicle.addToWorld(world);

  // Labels for hud/suspensionHud.js's generic per-wheel bars, in the same
  // order as vehicle.wheelInfos (see wheelPositions above).
  vehicle.wheelLabels = ['FL', 'FR', 'RL', 'RR'];

  // Per-vehicle engine power (see app/input.js), as an independent
  // equivalent-bhp rating rather than a multiplier on any shared global
  // force - e.g. a monster-truck-style vehicle can simply carry a bigger
  // enginePowerHp than the baseline rally car.
  vehicle.engineForce = hpToEngineForce(descriptor.enginePowerHp ?? DEFAULT_ENGINE_HP);

  // Per-vehicle handbrake strength (see app/input.js) - independent of any
  // shared global force, same pattern as engineForce above.
  vehicle.brakeForce = descriptor.brakeForce ?? DEFAULT_BRAKE_FORCE;

  // Signed forward speed (m/s) along the chassis' own local forward axis -
  // positive while coasting nose-first (the direction the "accelerate"
  // key drives towards), negative once actually moving in reverse. Lets
  // app/input.js tell "still rolling forward, the brake/reverse key
  // should brake" apart from "already stopped/reversing, it should apply
  // reverse thrust instead" - without this, holding reverse while still
  // rolling forward just fought the forward momentum with an equal and
  // opposite engine force (as slow as accelerating), instead of actually
  // braking at vehicle.brakeForce like a real brake pedal.
  const forwardAxisLocal = new CANNON.Vec3(
    vehicle.indexForwardAxis === 0 ? 1 : 0,
    vehicle.indexForwardAxis === 1 ? 1 : 0,
    vehicle.indexForwardAxis === 2 ? 1 : 0
  );
  const forwardAxisWorldScratch = new CANNON.Vec3();
  vehicle.getForwardSpeed = () => {
    chassisBody.vectorToWorldFrame(forwardAxisLocal, forwardAxisWorldScratch);
    return chassisBody.velocity.dot(forwardAxisWorldScratch);
  };

  // --- Wheel hitboxes (pedestrians) ---
  // The chassis' own collision shapes (carHullPrism + the 8 corner
  // spheres above) sit close against the body shell, well inboard of
  // where the wheels actually are (see wheelAttachY/suspensionRestLength/
  // radius) - a pedestrian clipped by a wheel sticking out past the
  // body (very visible on a wide-tired vehicle like
  // lib/vehicles/bigfoot.js) would never register a hit at all. One
  // kinematic sphere per wheel, sized to that vehicle's own wheelRadius
  // and re-positioned every physics step from the wheel's real simulated
  // transform (steering + suspension compression + spin all included),
  // fixes that without touching the chassis' actual driving
  // physics: masked to only ever collide with pedestrians (group 16 -
  // see lib/pedestrians.js's PED_GROUP/lib/remoteCollisions.js's group
  // map), so it never touches the ground trimesh or buildings and can't
  // fight the RaycastVehicle's own suspension forces.
  const WHEEL_HITBOX_PED_GROUP = 16;
  const wheelHitboxBodies = wheelPositions.map(() => {
    const body = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.KINEMATIC,
      collisionFilterGroup: 1,
      collisionFilterMask: WHEEL_HITBOX_PED_GROUP,
    });
    body.addShape(new CANNON.Sphere(wheelRadius));
    world.addBody(body);
    return body;
  });
  const syncWheelHitboxes = () => {
    for (let i = 0; i < wheelHitboxBodies.length; i++) {
      vehicle.updateWheelTransform(i);
      const t = vehicle.wheelInfos[i].worldTransform;
      wheelHitboxBodies[i].position.copy(t.position);
      wheelHitboxBodies[i].quaternion.copy(t.quaternion);
    }
  };
  world.addEventListener('preStep', syncWheelHitboxes);
  vehicle.wheelHitboxBodies = wheelHitboxBodies;
  // Tell the suspension raycasts (lib/wheeledVehicle.js) to ignore these -
  // each one sits centered exactly on its own wheel, so without this the
  // wheel's own hitbox is the closest thing its suspension ray can hit
  // (well before the actual ground/building), reading as instantly
  // bottomed-out suspension.
  vehicle.ignoreBodies.push(...wheelHitboxBodies);

  // cannon-es's updateMassProperties() approximates a body's rotational
  // inertia from a box matching just its *shapes'* AABB - here, the thin
  // chassisHeight-tall hull/hitbox spheres. It has no idea the wheels hang
  // ~wheelAttachY - suspensionRestLength - radius below that (~1.4m) and
  // ~wheelFront/wheelBack ahead/behind it, which is exactly where engine/
  // suspension forces actually get applied. That under-sized inertia made
  // the car absurdly easy to flip end-over-end under hard acceleration: a
  // real car resists nose-up "wheelie" pitch with the rotational inertia
  // of its *whole* mass distribution (engine, wheels, drivetrain) spread
  // across its true footprint, not just a thin shell around its center.
  // Recomputing the box-inertia approximation with the vehicle's actual
  // footprint (track width x true ground-to-origin height x wheelbase)
  // instead gives pitch/roll resistance in the right ballpark, without
  // touching collision shapes, mass, or handling (yaw inertia, the one
  // most players actually feel while steering, is barely affected since
  // width/length dominate that axis either way).
  const groundDrop = -wheelAttachY + wheelOptions.suspensionRestLength + wheelOptions.radius;
  const inertiaHalfExtents = new CANNON.Vec3(axleWidth, groundDrop, wheelFront - wheelBack);
  CANNON.Box.calculateInertia(inertiaHalfExtents, chassisBody.mass, chassisBody.inertia);
  chassisBody.invInertia.set(
    chassisBody.inertia.x > 0 ? 1 / chassisBody.inertia.x : 0,
    chassisBody.inertia.y > 0 ? 1 / chassisBody.inertia.y : 0,
    chassisBody.inertia.z > 0 ? 1 / chassisBody.inertia.z : 0
  );
  chassisBody.updateInertiaWorld(true);

  // Extra angular damping on top of that so any residual spin (a hard
  // launch, a bump, a graze off a wall) bleeds off instead of building
  // into a tumble - real cars have plenty of rotational drag/friction this
  // simplified rigid body otherwise lacks entirely (default is ~0.01).
  chassisBody.angularDamping = 0.6;

  // --- Air drag ---
  // Anti-wheelie pitch correction and anti-flip stability assist used to
  // live here as a bolt-on fix for cannon-es's RaycastVehicle (reconstruct
  // the torque it just applied, then subtract most of it back out; nudge
  // the chassis back upright if it tips too far). Both are gone now - the
  // replacement vehicle rig (lib/wheeledVehicle.js) applies its forward/
  // lateral tyre impulses through an already-reduced lever arm (pitch/roll
  // influence) at the moment the impulse happens, so the excess torque
  // never gets injected into angularVelocity in the first place, and the
  // corrected inertia tensor + angularDamping above are enough on their
  // own to keep landings/bumps settling naturally instead of needing a
  // rubber-banded "stay upright" assist.
  // Universal directional air drag (see lib/airDrag.js) - this vehicle's
  // own dragProfile (falling back to a generic default for any descriptor
  // that doesn't define one), applied relative to the chassis' own
  // current facing (its local +Z, same "front" convention every rig here
  // uses).
  const dragProfile = descriptor.dragProfile ?? DEFAULT_DRAG_PROFILE;
  const dragForwardLocal = new CANNON.Vec3(0, 0, 1);
  const dragForwardWorld = new CANNON.Vec3();
  const stabilityAssistCallback = () => {
    chassisBody.vectorToWorldFrame(dragForwardLocal, dragForwardWorld);
    applyAirDrag(chassisBody, dragForwardWorld, dragProfile);
  };
  world.addEventListener('preStep', stabilityAssistCallback);

  // --- Three.js mesh: selected vehicle's body ---
  // Built by the vehicle descriptor (see lib/vehicles/index.js), sized to
  // roughly match the chassis hitbox (chassisWidth x chassisLength) so it
  // still lines up with the wheels and physics body.
  const { group: chassisMesh } = getVehicle(vehicleId).buildBody(chassisWidth, chassisLength, color);
  THREE_scene.add(chassisMesh);

  // Debug-only wireframe marking the chassis' actual physics hitbox: the
  // tapered car-outline prism (carHullPrism above) plus the 8 corner
  // spheres (the ground-rollover safety net) - parented directly to
  // chassisMesh, whose transform tracks chassisBody 1:1 (see syncMeshes
  // below), so these move/rotate with the car for free.
  const hitboxMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, depthTest: false });
  const hitboxMeshes = [];

  const carHullShape2D = new THREE.Shape();
  carHullPoints.forEach((p, i) => {
    if (i === 0) carHullShape2D.moveTo(p.x, -p.z);
    else carHullShape2D.lineTo(p.x, -p.z);
  });
  const carHullGeometry = new THREE.ExtrudeGeometry(carHullShape2D, {
    depth: chassisHeight,
    bevelEnabled: false,
    curveSegments: 1,
  });
  carHullGeometry.rotateX(-Math.PI / 2);
  carHullGeometry.translate(0, -chassisHeight / 2, 0);
  const carHullMesh = new THREE.Mesh(carHullGeometry, hitboxMaterial);
  carHullMesh.visible = false;
  carHullMesh.renderOrder = 999;
  chassisMesh.add(carHullMesh);
  hitboxMeshes.push(carHullMesh);

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const sphereMesh = new THREE.Mesh(new THREE.SphereGeometry(hitboxRadius, 8, 6), hitboxMaterial);
        sphereMesh.position.set(
          sx * (chassisWidth / 2 - hitboxRadius),
          sy * (chassisHeight / 2 - hitboxRadius),
          sz * (chassisLength / 2 - hitboxRadius)
        );
        sphereMesh.visible = false;
        sphereMesh.renderOrder = 999;
        chassisMesh.add(sphereMesh);
        hitboxMeshes.push(sphereMesh);
      }
    }
  }
  function setHitboxVisible(visible) {
    for (const m of hitboxMeshes) m.visible = visible;
  }

  const wheelMeshes = wheelPositions.map(() => buildRallyWheel(wheelOptions.radius, THREE_scene));

  // --- Fixed-step physics / variable-rate render decoupling ---
  // world.step() advances the simulation in discrete FIXED_STEP chunks, but
  // requestAnimationFrame deltas rarely divide evenly into that step, so the
  // number of physics substeps taken can flicker between e.g. 1 and 2 from
  // frame to frame. At high speed that shows up as visible jitter/stutter
  // (the car covers a different distance each render frame even though real
  // motion is smooth). Fix: snapshot the previous/current physics transform
  // every fixed step, then interpolate between them for rendering using how
  // far we are into the next step (alpha), independent of render frame rate.
  const prevChassisPos = new THREE.Vector3().copy(chassisBody.position);
  const currChassisPos = new THREE.Vector3().copy(chassisBody.position);
  const prevChassisQuat = new THREE.Quaternion().copy(chassisBody.quaternion);
  const currChassisQuat = new THREE.Quaternion().copy(chassisBody.quaternion);

  const prevWheelPos = wheelPositions.map(() => new THREE.Vector3());
  const currWheelPos = wheelPositions.map(() => new THREE.Vector3());
  const prevWheelQuat = wheelPositions.map(() => new THREE.Quaternion());
  const currWheelQuat = wheelPositions.map(() => new THREE.Quaternion());

  function readWheelTransforms(targetPosArr, targetQuatArr) {
    vehicle.wheelInfos.forEach((wheel, i) => {
      vehicle.updateWheelTransform(i);
      const t = wheel.worldTransform;
      targetPosArr[i].copy(t.position);
      targetQuatArr[i].copy(t.quaternion);
    });
  }
  readWheelTransforms(prevWheelPos, prevWheelQuat);
  readWheelTransforms(currWheelPos, currWheelQuat);

  // Call this once right after every fixed world.step() (not once per render
  // frame) so prev/curr always bracket exactly one physics step.
  function snapshotPhysics() {
    prevChassisPos.copy(currChassisPos);
    prevChassisQuat.copy(currChassisQuat);
    currChassisPos.copy(chassisBody.position);
    currChassisQuat.copy(chassisBody.quaternion);

    for (let i = 0; i < wheelPositions.length; i++) {
      prevWheelPos[i].copy(currWheelPos[i]);
      prevWheelQuat[i].copy(currWheelQuat[i]);
    }
    readWheelTransforms(currWheelPos, currWheelQuat);
  }

  // Snaps prev === curr at the current physics state, so the next render
  // doesn't interpolate from a stale pre-teleport transform (used on reset).
  function resetInterpolation() {
    currChassisPos.copy(chassisBody.position);
    currChassisQuat.copy(chassisBody.quaternion);
    prevChassisPos.copy(currChassisPos);
    prevChassisQuat.copy(currChassisQuat);

    readWheelTransforms(currWheelPos, currWheelQuat);
    for (let i = 0; i < wheelPositions.length; i++) {
      prevWheelPos[i].copy(currWheelPos[i]);
      prevWheelQuat[i].copy(currWheelQuat[i]);
    }
  }

  // alpha in [0, 1]: how far between the previous and current physics step
  // we are when this render frame fires. Pass 1 (default) to skip
  // interpolation and snap straight to the latest physics state.
  function syncMeshes(alpha = 1) {
    chassisMesh.position.lerpVectors(prevChassisPos, currChassisPos, alpha);
    chassisMesh.quaternion.slerpQuaternions(prevChassisQuat, currChassisQuat, alpha);

    wheelMeshes.forEach((mesh, i) => {
      mesh.position.lerpVectors(prevWheelPos[i], currWheelPos[i], alpha);
      mesh.quaternion.slerpQuaternions(prevWheelQuat[i], currWheelQuat[i], alpha);
    });
  }

  // With no arguments, rights the car where it currently is: keeps its
  // current x/z position (and lifts it a bit above its current spot in case
  // it landed on its roof/side) instead of teleporting back to the spawn
  // point. Pass explicit position/quaternion to override that behavior.
  // The actual lift is eased in over RESET_LIFT_DURATION_S by updateReset()
  // rather than snapped to instantly, so the car visibly (and slowly) rises
  // upright instead of popping there in a single frame.
  let liftAnim = null;

  function reset(position, quaternion) {
    const targetPosition = position ?? chassisBody.position.clone();
    if (!position) {
      // Lift from whichever is higher: the car's current position, or the
      // real terrain surface at its current x/z - covers the normal
      // "flip upright in place" case *and* recovering a car that's somehow
      // ended up underground (e.g. fell through before
      // app/collisions.js's ground-tunneling guard could catch it), where
      // lifting by a fixed offset from the (still-underground) current
      // position would just put it back underground.
      const groundY = findGroundY(world, targetPosition.x, targetPosition.z);
      if (groundY !== null && groundY > targetPosition.y) targetPosition.y = groundY;
      targetPosition.y += chassisHeight + 0.5;
    }
    const targetQuaternion = quaternion ?? uprightQuaternionPreservingHeading();

    liftAnim = {
      startPos: chassisBody.position.clone(),
      startQuat: chassisBody.quaternion.clone(),
      targetPos: targetPosition,
      targetQuat: targetQuaternion,
      elapsed: 0,
    };
    // Kinematic for the duration of the lift: immune to gravity/collisions
    // so nothing fights the eased motion, then handed back to normal
    // dynamics once it reaches the target pose.
    chassisBody.type = CANNON.Body.KINEMATIC;
    chassisBody.velocity.set(0, 0, 0);
    chassisBody.angularVelocity.set(0, 0, 0);

    resetInterpolation();
  }

  // Call every render frame (not just on fixed physics steps) so the lift's
  // duration is real wall-clock time regardless of physics substep count.
  function updateReset(dt) {
    if (!liftAnim) return;
    liftAnim.elapsed += dt;
    const t = Math.min(liftAnim.elapsed / RESET_LIFT_DURATION_S, 1);
    // Ease-out: brisk start, gentle settle into the final pose.
    const eased = 1 - (1 - t) * (1 - t);
    liftAnim.startPos.lerp(liftAnim.targetPos, eased, chassisBody.position);
    liftAnim.startQuat.slerp(liftAnim.targetQuat, eased, chassisBody.quaternion);

    if (t >= 1) {
      chassisBody.type = CANNON.Body.DYNAMIC;
      chassisBody.velocity.set(0, 0, 0);
      chassisBody.angularVelocity.set(0, 0, 0);
      liftAnim = null;
    }
  }

  // Keeps the car's current heading (yaw) but zeroes out any roll/pitch,
  // so an in-place reset rights a flipped car facing the same direction.
  function uprightQuaternionPreservingHeading() {
    const euler = new CANNON.Vec3();
    chassisBody.quaternion.toEuler(euler);
    const upright = new CANNON.Quaternion();
    upright.setFromEuler(0, euler.y, 0);
    return upright;
  }


  // Tears down the per-wheel pedestrian hitboxes (see above) - these are
  // extra bodies/listeners beyond the one chassisBody/chassisMesh pair
  // app/carManager.js's removeCurrentCar() cleans up generically, so (like
  // the hover rig's own dispose - see lib/chariot.js) they need their own
  // explicit teardown on despawn/vehicle-swap.
  function dispose() {
    world.removeEventListener('preStep', syncWheelHitboxes);
    for (const body of wheelHitboxBodies) world.removeBody(body);
  }

  return {
    vehicle,
    chassisBody,
    chassisMesh,
    wheelMeshes,
    syncMeshes,
    snapshotPhysics,
    reset,
    updateReset,
    setHitboxVisible,
    stabilityAssistCallback,
    dispose,
  };
}

/**
 * Visual-only copy of the local car (no physics) for other players.
 * Wheels are parented to the chassis and spun from the replicated speed.
 * Hover vehicles (see createCar above) have no wheels to spin, so they're
 * delegated to createRemoteChariot instead - see lib/chariot.js.
 */
export function createRemoteCar(THREE_scene, color = DEFAULT_BODY_COLOR, name = '', score = 0, vehicleId = DEFAULT_VEHICLE_ID) {
  const descriptor = getVehicle(vehicleId);
  if (descriptor.vehicleType === 'hover') {
    return createRemoteChariot(THREE_scene, color, name, score, descriptor);
  }

  const { group, bodyMat } = descriptor.buildBody(CHASSIS_WIDTH, CHASSIS_LENGTH, color);
  const nameTag = createNameTag(name, score);
  group.add(nameTag.sprite);

  // Match the local rig's per-vehicle wheel size (see createCar above) so a
  // bigger-wheeled vehicle (e.g. a monster truck) doesn't look stock-sized
  // on other players' screens.
  const wheelRadius = descriptor.wheelRadius ?? WHEEL_RADIUS;
  const axleWidth = CHASSIS_WIDTH / 2 - 0.1;
  const wheelAttachY = -CHASSIS_HEIGHT / 2;
  const wheelLocals = [
    [-axleWidth, wheelAttachY, 1.3],
    [axleWidth, wheelAttachY, 1.3],
    [-axleWidth, wheelAttachY, -1.3],
    [axleWidth, wheelAttachY, -1.3],
  ];
  const wheelMeshes = wheelLocals.map(([x, y, z]) => {
    const wheel = buildRallyWheel(wheelRadius, group);
    wheel.position.set(x, y, z);
    wheel.rotation.order = 'YXZ';
    return wheel;
  });

  THREE_scene.add(group);

  let spin = 0;
  let currentColor = color;

  function setPose(pose, dt) {
    group.position.set(pose.x, pose.y, pose.z);
    group.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw).normalize();
    spin = (spin + (pose.speed / wheelRadius) * dt) % (Math.PI * 2);
    wheelMeshes.forEach((wheel, i) => {
      wheel.rotation.y = i < 2 ? pose.steer : 0;
      wheel.rotation.x = spin;
    });
  }

  function setAppearance(nextColor, nextName, nextScore = 0) {
    if (nextColor !== currentColor) {
      currentColor = nextColor;
      bodyMat.color.set(nextColor);
    }
    nameTag.set(nextName, nextScore);
  }

  function dispose() {
    THREE_scene.remove(group);
    const materials = new Set();
    const geometries = new Set();
    group.traverse((obj) => {
      if (obj.geometry) geometries.add(obj.geometry);
      if (obj.material) {
        materials.add(obj.material);
        if (obj.material.map) obj.material.map.dispose();
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }

  return { setPose, setAppearance, dispose };
}
