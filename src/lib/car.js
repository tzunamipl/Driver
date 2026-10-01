import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { getVehicle, DEFAULT_VEHICLE_ID } from './vehicles/index.js';
import { CHASSIS_MATERIAL, createNameTag } from './vehicleShared.js';
import { createChariotVehicle, createRemoteChariot } from './chariot.js';

// Re-exported from vehicleShared.js (not defined here) so every existing
// `import { CHASSIS_MATERIAL } from './lib/car.js'` call site keeps
// working unchanged - see vehicleShared.js for why it had to move out of
// this file (lib/chariot.js, the hover-vehicle rig, needs it too, and
// importing it back from here would be circular).
export { CHASSIS_MATERIAL, createNameTag };

const DEFAULT_BODY_COLOR = 0x1c3f94; // WRC blue
const CHASSIS_WIDTH = 1.8;
const CHASSIS_HEIGHT = 0.6;
const CHASSIS_LENGTH = 4;
const WHEEL_RADIUS = 0.4;
// How long a reset's lift-back-upright takes to ease into place, instead of
// snapping there in a single instantaneous teleport.
const RESET_LIFT_DURATION_S = 0.6;


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
 */
function buildRallyWheel(radius, parent) {
  const group = new THREE.Group();

  const tireGeo = new THREE.CylinderGeometry(radius, radius, 0.3, 20);
  tireGeo.rotateZ(Math.PI / 2);
  const tire = new THREE.Mesh(tireGeo, new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 }));
  tire.castShadow = true;
  group.add(tire);

  const rimGeo = new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, 0.32, 8);
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
  const chassisBody = new CANNON.Body({ mass: 150, material: CHASSIS_MATERIAL });
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
  const vehicle = new CANNON.RaycastVehicle({
    chassisBody,
    indexRightAxis: 0,
    indexUpAxis: 1,
    indexForwardAxis: 2,
  });

  const wheelOptions = {
    radius: WHEEL_RADIUS,
    directionLocal: new CANNON.Vec3(0, -1, 0),
    suspensionStiffness: 10,
    suspensionRestLength: 0.55,
    frictionSlip: 5,
    dampingRelaxation: 1.4,
    dampingCompression: 2.0,
    maxSuspensionForce: 100000,
    rollInfluence: 0.01,
    axleLocal: new CANNON.Vec3(-1, 0, 0),
    chassisConnectionPointLocal: new CANNON.Vec3(1, 0, 1),
    maxSuspensionTravel: 0.95,
    customSlidingRotationalSpeed: -30,
    useCustomSlidingRotationalSpeed: true,
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

  // --- Anti-wheelie pitch correction ---
  // The real root cause of "flips under acceleration": cannon-es's
  // RaycastVehicle.updateFriction() applies the *forward* (engine/brake)
  // friction impulse at the wheel's actual ground contact point, using its
  // full, undamped lever arm back to the chassis' center of mass - unlike
  // the *side* impulse, which it deliberately shrinks via `rollInfluence`
  // for exactly this reason (see cannon-es's own updateFriction source:
  // `rel_pos['xyz'][indexUpAxis] *= wheel.rollInfluence` only touches
  // wheel.sideImpulse, never wheel.forwardImpulse). With the wheels ~1.4m
  // below the chassis origin, hard acceleration/braking keeps injecting a
  // big nose-up/down torque every step with nothing in the library to damp
  // it - bigger rotational inertia (above) only slows how fast that
  // builds, it never stops it. This reconstructs the exact torque cannon
  // just applied for each wheel's forward impulse (from public WheelInfo
  // state - forwardImpulse, hitPointWorld, hitNormalWorld, the wheel's own
  // steered worldTransform - mirroring cannon's own forwardWS computation)
  // and cancels all but a small PITCH_INFLUENCE fraction of it, the same
  // way rollInfluence does for cornering - so accelerating/braking still
  // pushes the car forward/back at full force, it just stops also trying
  // to flip it end over end.
  const PITCH_INFLUENCE = 0.05;
  const pitchRightAxisLocal = [new CANNON.Vec3(1, 0, 0), new CANNON.Vec3(0, 1, 0), new CANNON.Vec3(0, 0, 1)][
    vehicle.indexRightAxis
  ];
  const pitchAxle = new CANNON.Vec3();
  const pitchSurfScaledProj = new CANNON.Vec3();
  const pitchForward = new CANNON.Vec3();
  const pitchRelPos = new CANNON.Vec3();
  const pitchRelPosLocal = new CANNON.Vec3();
  const pitchRelPosScaled = new CANNON.Vec3();
  const pitchImpulseVec = new CANNON.Vec3();
  const pitchTorqueFull = new CANNON.Vec3();
  const pitchTorqueScaled = new CANNON.Vec3();
  const pitchTorqueDelta = new CANNON.Vec3();
  const pitchAngularDelta = new CANNON.Vec3();
  function correctWheelieTorque() {
    for (let i = 0; i < vehicle.wheelInfos.length; i++) {
      const wheel = vehicle.wheelInfos[i];
      if (!wheel.raycastResult.body || wheel.forwardImpulse === 0) continue;
      const hitNormal = wheel.raycastResult.hitNormalWorld;

      // Reconstruct this wheel's "forward" world direction the same way
      // cannon-es's updateFriction just did (it doesn't expose forwardWS
      // on WheelInfo, so it's cheap to redo from public state).
      wheel.worldTransform.quaternion.vmult(pitchRightAxisLocal, pitchAxle);
      const proj = pitchAxle.dot(hitNormal);
      hitNormal.scale(proj, pitchSurfScaledProj);
      pitchAxle.vsub(pitchSurfScaledProj, pitchAxle);
      pitchAxle.normalize();
      hitNormal.cross(pitchAxle, pitchForward);
      pitchForward.normalize();

      wheel.raycastResult.hitPointWorld.vsub(chassisBody.position, pitchRelPos);
      pitchForward.scale(wheel.forwardImpulse, pitchImpulseVec);
      pitchRelPos.cross(pitchImpulseVec, pitchTorqueFull);

      // Same trick as rollInfluence: shrink the lever arm's vertical
      // (up-axis) component specifically, in the chassis' own local frame.
      chassisBody.vectorToLocalFrame(pitchRelPos, pitchRelPosLocal);
      pitchRelPosLocal.y *= PITCH_INFLUENCE;
      chassisBody.vectorToWorldFrame(pitchRelPosLocal, pitchRelPosScaled);
      pitchRelPosScaled.cross(pitchImpulseVec, pitchTorqueScaled);

      // Remove exactly the excess torque cannon's applyImpulse() call
      // already added to angularVelocity for this wheel this step.
      pitchTorqueFull.vsub(pitchTorqueScaled, pitchTorqueDelta);
      chassisBody.invInertiaWorld.vmult(pitchTorqueDelta, pitchAngularDelta);
      chassisBody.angularVelocity.vsub(pitchAngularDelta, chassisBody.angularVelocity);
    }
  }

  // --- Anti-flip stability assist ---
  // Belt-and-braces on top of the pitch correction above: every physics
  // step, once the vehicle's own forces for that step are already applied
  // (this listener runs after vehicle.preStepCallback within the same
  // 'preStep' dispatch - see cannon-es's World.internalStep), nudge the
  // chassis back toward upright whenever it's still reasonably level and
  // at least one wheel is touching the ground (catches bumps/landings the
  // targeted correction above doesn't, e.g. an uneven touchdown). It
  // deliberately stops helping once the chassis tips past
  // STABILITY_MAX_TILT_DOT (~53 degrees), so a real crash, rollover, or
  // stunt-jump flip still plays out physically instead of being invisibly
  // rubber-banded upright.
  const STABILITY_MAX_TILT_DOT = 0.6;
  const STABILITY_GAIN = 12;
  const stabilityWorldUp = new CANNON.Vec3(0, 1, 0);
  const stabilityCarUp = new CANNON.Vec3();
  const stabilityCorrection = new CANNON.Vec3();
  const stabilityAssistCallback = () => {
    correctWheelieTorque();

    if (vehicle.numWheelsOnGround === 0) return; // airborne - let real physics fully take over
    stabilityCarUp.set(0, 1, 0);
    chassisBody.vectorToWorldFrame(stabilityCarUp, stabilityCarUp);
    const uprightDot = stabilityCarUp.dot(stabilityWorldUp);
    if (uprightDot <= STABILITY_MAX_TILT_DOT) return; // tipped too far - a real flip is already underway
    stabilityCarUp.cross(stabilityWorldUp, stabilityCorrection);
    const dt = world.dt > 0 ? world.dt : 0;
    chassisBody.angularVelocity.x += stabilityCorrection.x * STABILITY_GAIN * dt;
    chassisBody.angularVelocity.y += stabilityCorrection.y * STABILITY_GAIN * dt;
    chassisBody.angularVelocity.z += stabilityCorrection.z * STABILITY_GAIN * dt;
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
    if (!position) targetPosition.y += chassisHeight + 0.5;
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

  const axleWidth = CHASSIS_WIDTH / 2 - 0.1;
  const wheelAttachY = -CHASSIS_HEIGHT / 2;
  const wheelLocals = [
    [-axleWidth, wheelAttachY, 1.3],
    [axleWidth, wheelAttachY, 1.3],
    [-axleWidth, wheelAttachY, -1.3],
    [axleWidth, wheelAttachY, -1.3],
  ];
  const wheelMeshes = wheelLocals.map(([x, y, z]) => {
    const wheel = buildRallyWheel(WHEEL_RADIUS, group);
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
    spin = (spin + (pose.speed / WHEEL_RADIUS) * dt) % (Math.PI * 2);
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
