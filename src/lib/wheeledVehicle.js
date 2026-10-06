import * as CANNON from 'cannon-es';
import { getSurfaceCompound, DEFAULT_SURFACE_KEY } from './surfaceCompounds.js';

// Self-contained replacement for cannon-es's CANNON.RaycastVehicle, built
// from scratch instead of layering fixes on top of it (see car.js's former
// correctWheelieTorque()/stabilityAssistCallback() hacks, now gone - their
// jobs are handled naturally below instead of being patched in after the
// fact). Keeps the exact public surface every call site already relies on
// (wheelInfos[].{worldTransform,suspensionLength,suspensionRestLength,
// maxSuspensionTravel,steering,radius}, numWheelsOnGround, wheelLabels,
// addWheel/setSteeringValue/applyEngineForce/setBrake/updateWheelTransform/
// addToWorld) so app/input.js, app/scoring.js, app/mainLoop.js,
// hud/suspensionHud.js and lib/wheelContact.js keep working unmodified -
// only the internals (how suspension/friction forces are actually derived)
// are new.
//
// Three behavioural upgrades over cannon-es's own RaycastVehicle, all
// aimed at "feels natural, reacts to the world" rather than "feels
// hand-tuned to stop flipping":
//   1. Each wheel's ray spans its *entire* suspension travel (rest length
//      + max travel), not just the rest length. Cannon's own vehicle only
//      casts restLength+radius, so a wheel dropping into a dip or
//      clipping the lip of a building/curb loses ground contact a beat
//      early and "pops" instead of smoothly extending - this casts far
//      enough to track the wheel across its whole droop range, so bumps,
//      curbs and building edges compress/extend the spring instead of
//      snapping it.
//   2. Suspension force is applied along the actual hit surface normal
//      (not the chassis' own local "down" axis), so clipping the angled
//      face of a building or a kerb naturally shoves the car up and
//      sideways along that face instead of straight along the chassis
//      axis - the same reason a real wheel glances off an angled curb
//      instead of just compressing vertically.
//   3. Both the forward (accel/brake) and lateral (cornering) tyre
//      impulses use a proper rotational-effective-mass solve (same
//      impulse-denominator math cannon-es itself already uses for
//      rolling friction, just applied consistently to both axes instead
//      of only one), and *both* are applied through a reduced lever arm
//      (pitchInfluence/rollInfluence) at the moment the impulse is
//      applied - so the car simply never accumulates the excess
//      wheelie/flip torque cannon-es's own vehicle does, instead of
//      generating it and then subtracting it back out a step later.
//   4. Each wheel also applies rolling resistance (Frr = Crr(v) * Fz, Crr
//      growing with speed) any time it's loaded and moving, independent
//      of engine/brake input - so a car coasts to a stop on a flat road
//      like a real one instead of rolling forever once up to speed.
const UP_LOCAL = new CANNON.Vec3(0, 1, 0);

const DEFAULT_WHEEL_OPTIONS = {
  radius: 0.4,
  directionLocal: new CANNON.Vec3(0, -1, 0),
  axleLocal: new CANNON.Vec3(-1, 0, 0),
  chassisConnectionPointLocal: new CANNON.Vec3(0, 0, 0),
  suspensionStiffness: 35,
  suspensionRestLength: 0.55,
  maxSuspensionTravel: 0.35,
  // car.js computes its own mass-derived value (see DEFAULT_SUSPENSION_FORCE_G
  // there) and every current vehicle descriptor gets one - this is only a
  // fallback for callers that don't go through car.js at all.
  maxSuspensionForce: 1e6,
  dampingCompression: 5.92,
  dampingRelaxation: 8.87,
  frictionSlip: 1.6, // mu - see car.js's matching comment for why not 5
  // Rolling resistance coefficient (dimensionless, Crr at near-zero speed)
  // - a real tyre constantly loses a little energy to deformation at the
  // contact patch, so it never coasts forever even with the engine off and
  // no brake applied. Modelled as a force opposing rolling motion,
  // proportional to the wheel's own normal load (suspensionForce) the same
  // way real rolling resistance is (Frr = Crr(v) * Fz) - see
  // applyFriction's rollingResistance handling below. 0.015 is a typical
  // asphalt value for a road tyre at low speed; per-vehicle descriptors can
  // override it (e.g. knobby off-road tyres) via car.js's suspension
  // overrides, same as frictionSlip/rollInfluence above.
  rollingResistance: 0.015,
  // How much rollingResistance grows with speed - real tyres get
  // noticeably draggier as they go faster (more flex/heat/air resistance
  // in the tyre carcass itself), not just a flat drag force. Modelled as
  // Crr(v) = rollingResistance * (1 + rollingResistanceSpeedFactor * |v|)
  // (v in m/s) - 0.02 means Crr roughly doubles by ~50 m/s (180 km/h).
  rollingResistanceSpeedFactor: 0.08,
  rollInfluence: 0.01,
  // Mirrors the old standalone PITCH_INFLUENCE constant in car.js - how
  // much of the forward (accel/brake) impulse's true lever arm survives
  // when applied, the same trick rollInfluence already does for the
  // sideways impulse. Small values resist nose-up/down "wheelie" pitch
  // without killing straight-line acceleration itself.
  pitchInfluence: 0.05,
  customSlidingRotationalSpeed: -30,
  useCustomSlidingRotationalSpeed: false,
};

function axisVec(index) {
  return index === 0 ? new CANNON.Vec3(1, 0, 0) : index === 1 ? new CANNON.Vec3(0, 1, 0) : new CANNON.Vec3(0, 0, 1);
}

// Same effective-mass math cannon-es's own computeImpulseDenominator uses
// (1/m_eff = invMass + dir . ((invInertiaWorld . (r x dir)) x r)) - reused
// here for *both* the forward and lateral tyre impulses (cannon-es itself
// only bothers with it for rolling friction, and falls back to a cruder
// mass-only solve for the side impulse) so cornering grip accounts for the
// car's actual rotational inertia the same way acceleration grip already
// does.
const idR = new CANNON.Vec3();
const idC = new CANNON.Vec3();
const idM = new CANNON.Vec3();
const idVec = new CANNON.Vec3();
function impulseDenominator(body, pos, dir) {
  if (body.invMass === 0 && !body.invInertiaWorld) return 0;
  pos.vsub(body.position, idR);
  idR.cross(dir, idC);
  body.invInertiaWorld.vmult(idC, idM);
  idM.cross(idR, idVec);
  return body.invMass + dir.dot(idVec);
}

const velAtPoint1 = new CANNON.Vec3();
const velAtPoint2 = new CANNON.Vec3();
const relVelVec = new CANNON.Vec3();
// Solves for the impulse (along `dir`) that would zero out the relative
// velocity between the two bodies at `pos`, clamped to +/-maxImpulse -
// shared by both the forward and lateral friction solves below.
function solveBilateralImpulse(bodyA, bodyB, pos, dir, maxImpulse) {
  bodyA.getVelocityAtWorldPoint(pos, velAtPoint1);
  if (bodyB) bodyB.getVelocityAtWorldPoint(pos, velAtPoint2);
  else velAtPoint2.set(0, 0, 0);
  velAtPoint1.vsub(velAtPoint2, relVelVec);
  const relVel = dir.dot(relVelVec);
  const denomA = impulseDenominator(bodyA, pos, dir);
  const denomB = bodyB ? impulseDenominator(bodyB, pos, dir) : 0;
  const denom = denomA + denomB;
  if (denom <= 1e-9) return 0;
  let impulse = -relVel / denom;
  if (impulse > maxImpulse) impulse = maxImpulse;
  if (impulse < -maxImpulse) impulse = -maxImpulse;
  return impulse;
}

/**
 * Creates a from-scratch, cannon-es-RaycastVehicle-API-compatible wheeled
 * vehicle rig: per-wheel raycast suspension (spring+damper) plus a
 * friction-circle tyre model (engine/brake longitudinal force, cornering
 * lateral force, combined grip limited by load x frictionSlip). See the
 * file header above for how/why it differs from cannon-es's own
 * RaycastVehicle.
 */
export function createWheeledVehicle({ chassisBody, indexRightAxis = 0, indexForwardAxis = 2, indexUpAxis = 1 }) {
  const vehicle = {
    chassisBody,
    indexRightAxis,
    indexForwardAxis,
    indexUpAxis,
    wheelInfos: [],
    numWheelsOnGround: 0,
    world: null,
  };

  const rightAxisLocal = axisVec(indexRightAxis);
  const forwardAxisLocal = axisVec(indexForwardAxis);

  function addWheel(options = {}) {
    const wheel = {
      ...DEFAULT_WHEEL_OPTIONS,
      ...options,
      steering: 0,
      engineForce: 0,
      brake: 0,
      rotation: 0,
      deltaRotation: 0,
      suspensionLength: 0,
      suspensionForce: 0,
      isInContact: false,
      sliding: false,
      // Signed forward-axis slip speed of the tyre's contact patch
      // relative to the ground (m/s) - zero for a wheel rolling without
      // slip, nonzero (and sign-flipped vs. the car's own motion) when
      // the wheel is spinning faster/slower than the car is actually
      // travelling (wheelspin/lockup), see the computation alongside
      // deltaRotation below. Consumed by lib/tireSmoke.js/
      // lib/terrainDust.js to kick dust/smoke out in the direction the
      // overspinning tyre tread is actually throwing it, not just the
      // direction the car itself is moving.
      spinSlipSpeed: 0,
      // World-space forward direction of this wheel's contact patch (the
      // same frictionForward computed fresh each applyFriction call
      // below), persisted so the dust/smoke effects above know which way
      // "forward" is for this wheel without recomputing the friction
      // solve themselves. Stays at its last-grounded value while the
      // wheel is airborne (harmless - callers already gate on
      // isWheelGrounded).
      forwardWorld: new CANNON.Vec3(),
      // Ground-surface key (road/water/normal - see surfaceCompounds.js),
      // driven every frame by app/mainLoop.js's classifySurfaceAt call
      // from this wheel's last-known world position; defaults to the
      // generic surface until the first frame sets it (e.g. the very
      // first physics step after spawn).
      surface: DEFAULT_SURFACE_KEY,
      connectionPointWorld: new CANNON.Vec3(),
      directionWorld: new CANNON.Vec3(),
      axleWorld: new CANNON.Vec3(),
      worldTransform: {
        position: new CANNON.Vec3(),
        quaternion: new CANNON.Quaternion(),
      },
      raycastResult: {
        body: null,
        hitPointWorld: new CANNON.Vec3(),
        hitNormalWorld: new CANNON.Vec3(),
        distance: 0,
      },
    };
    vehicle.wheelInfos.push(wheel);
    return vehicle.wheelInfos.length - 1;
  }

  function setSteeringValue(value, i) {
    vehicle.wheelInfos[i].steering = value;
  }
  function applyEngineForce(value, i) {
    vehicle.wheelInfos[i].engineForce = value;
  }
  function setBrake(value, i) {
    vehicle.wheelInfos[i].brake = value;
  }

  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const rayResult = new CANNON.RaycastResult();
  // Other bodies that belong to this same vehicle rig but aren't the
  // chassis itself (e.g. car.js's per-wheel kinematic pedestrian-hitbox
  // spheres, synced to sit right on top of each wheel) - populated by the
  // caller via vehicle.ignoreBodies.push(...) after creation. Without
  // this, a wheel's own hitbox sphere (centered exactly on that wheel,
  // same spot the suspension ray travels through) is the *closest* thing
  // the ray can hit, well before the actual ground/building - which reads
  // as the suspension being instantly bottomed out against itself.
  vehicle.ignoreBodies = [];
  function castRay(wheel) {
    chassisBody.pointToWorldFrame(wheel.chassisConnectionPointLocal, wheel.connectionPointWorld);
    chassisBody.vectorToWorldFrame(wheel.directionLocal, wheel.directionWorld);
    chassisBody.vectorToWorldFrame(wheel.axleLocal, wheel.axleWorld);

    // Full travel range (see file header point 1), not just restLength.
    const rayLength = wheel.suspensionRestLength + wheel.maxSuspensionTravel + wheel.radius;
    rayFrom.copy(wheel.connectionPointWorld);
    wheel.directionWorld.scale(rayLength, rayTo);
    rayTo.vadd(rayFrom, rayTo);

    rayResult.reset();
    // Don't let a wheel ray hit its own chassis or any of this vehicle's
    // other non-ground bodies (see vehicle.ignoreBodies above) - toggle
    // their collisionResponse off for just this one raycast, same trick
    // cannon-es's own RaycastVehicle uses for the chassis.
    const selfBodies = [chassisBody, ...vehicle.ignoreBodies];
    const oldResponses = selfBodies.map((b) => b.collisionResponse);
    for (const b of selfBodies) b.collisionResponse = false;
    vehicle.world.raycastClosest(rayFrom, rayTo, {}, rayResult);
    selfBodies.forEach((b, i) => (b.collisionResponse = oldResponses[i]));

    const minLength = wheel.suspensionRestLength - wheel.maxSuspensionTravel;
    const maxLength = wheel.suspensionRestLength + wheel.maxSuspensionTravel;

    if (rayResult.hasHit && rayResult.body !== chassisBody) {
      wheel.isInContact = true;
      wheel.raycastResult.body = rayResult.body;
      wheel.raycastResult.hitPointWorld.copy(rayResult.hitPointWorld);
      wheel.raycastResult.hitNormalWorld.copy(rayResult.hitNormalWorld);
      wheel.raycastResult.distance = rayResult.distance;

      let length = rayResult.distance - wheel.radius;
      if (length < minLength) length = minLength;
      if (length > maxLength) length = maxLength;
      wheel.suspensionLength = length;
    } else {
      wheel.isInContact = false;
      wheel.raycastResult.body = null;
      wheel.suspensionLength = maxLength;
    }
  }

  const steeringOrn = new CANNON.Quaternion();
  const rotatingOrn = new CANNON.Quaternion();
  function updateWheelTransform(i) {
    const wheel = vehicle.wheelInfos[i];
    chassisBody.pointToWorldFrame(wheel.chassisConnectionPointLocal, wheel.connectionPointWorld);
    chassisBody.vectorToWorldFrame(wheel.directionLocal, wheel.directionWorld);
    chassisBody.vectorToWorldFrame(wheel.axleLocal, wheel.axleWorld);

    steeringOrn.setFromAxisAngle(UP_LOCAL, wheel.steering);
    rotatingOrn.setFromAxisAngle(rightAxisLocal, wheel.rotation);
    chassisBody.quaternion.mult(steeringOrn, wheel.worldTransform.quaternion);
    wheel.worldTransform.quaternion.mult(rotatingOrn, wheel.worldTransform.quaternion);
    wheel.worldTransform.quaternion.normalize();

    wheel.directionWorld.scale(wheel.suspensionLength, wheel.worldTransform.position);
    wheel.worldTransform.position.vadd(wheel.connectionPointWorld, wheel.worldTransform.position);
  }

  // --- Suspension: spring + damper, applied along the hit normal ---
  const suspensionImpulse = new CANNON.Vec3();
  const suspensionRelPos = new CANNON.Vec3();
  function applySuspension(wheel, dt) {
    if (!wheel.isInContact) {
      wheel.suspensionForce = 0;
      return;
    }
    const lengthDiff = wheel.suspensionRestLength - wheel.suspensionLength; // + = compressed
    const chassisMass = chassisBody.mass;

    chassisBody.getVelocityAtWorldPoint(wheel.raycastResult.hitPointWorld, velAtPoint1);
    const closingSpeed = -wheel.raycastResult.hitNormalWorld.dot(velAtPoint1); // + = compressing

    const damping = closingSpeed > 0 ? wheel.dampingCompression : wheel.dampingRelaxation;
    let force = wheel.suspensionStiffness * lengthDiff * chassisMass + damping * closingSpeed * chassisMass;
    if (force < 0) force = 0;
    if (force > wheel.maxSuspensionForce) force = wheel.maxSuspensionForce;
    wheel.suspensionForce = force;

    wheel.raycastResult.hitNormalWorld.scale(force * dt, suspensionImpulse);
    wheel.raycastResult.hitPointWorld.vsub(chassisBody.position, suspensionRelPos);
    chassisBody.applyImpulse(suspensionImpulse, suspensionRelPos);
  }

  // --- Tyre friction: forward (engine/brake) + lateral (cornering),
  // combined in one friction circle limited by load x frictionSlip ---
  const frictionForward = new CANNON.Vec3();
  const frictionAxle = new CANNON.Vec3();
  const frictionNormalScaledProj = new CANNON.Vec3();
  const frictionRelPos = new CANNON.Vec3();
  const frictionRelPosLocal = new CANNON.Vec3();
  const frictionRelPosScaled = new CANNON.Vec3();
  const frictionImpulseVec = new CANNON.Vec3();
  const frictionRelPos2 = new CANNON.Vec3();
  function applyFriction(wheel, dt) {
    wheel.sliding = false;
    wheel.gripFraction = 0;
    if (!wheel.isInContact) {
      wheel.spinSlipSpeed = 0;
      return;
    }

    const groundBody = wheel.raycastResult.body;
    const normal = wheel.raycastResult.hitNormalWorld;
    const hitPoint = wheel.raycastResult.hitPointWorld;

    // Steered axle/forward directions, projected flat onto the contact
    // plane (matches the wheel's own steered worldTransform).
    wheel.worldTransform.quaternion.vmult(rightAxisLocal, frictionAxle);
    const proj = frictionAxle.dot(normal);
    normal.scale(proj, frictionNormalScaledProj);
    frictionAxle.vsub(frictionNormalScaledProj, frictionAxle);
    frictionAxle.normalize();
    normal.cross(frictionAxle, frictionForward);
    frictionForward.normalize();
    wheel.forwardWorld.copy(frictionForward);

    // Per-surface tyre compound (road/water/normal - see
    // surfaceCompounds.js, set every frame on wheel.surface by
    // app/mainLoop.js's classifySurfaceAt): scales *and* offsets this
    // wheel's own base frictionSlip, then clamps the resulting raw grip
    // force to the compound's load-independent ceiling, before turning it
    // into this step's impulse budget - so e.g. water stays slippery
    // regardless of how loaded the wheel currently is, not just
    // proportionally grippier. Clamped to >= 0 since a large enough
    // negative frictionSlipOffset could otherwise flip grip negative for
    // a low-frictionSlip vehicle.
    const compound = getSurfaceCompound(wheel.surface);
    const effectiveFrictionSlip = Math.max(0, wheel.frictionSlip * compound.frictionMultiplier + compound.frictionSlipOffset);
    const rawGripForce = Math.min(wheel.suspensionForce * effectiveFrictionSlip, compound.maxForceN);
    const maxGrip = rawGripForce * dt;

    // Longitudinal: engine force (continuous push) plus brake treated as a
    // velocity-zeroing impulse (so the handbrake/brake actually locks
    // speed toward zero rather than fighting it with a fixed force).
    // wheel.brake is treated as a (generous) max impulse cap, the same
    // semantics cannon-es itself uses (not scaled by dt) - BRAKE_FORCE
    // (see config.js) is tuned large enough that this basically never
    // binds in practice, so the solve below (which already computes the
    // exact impulse needed to zero the wheel's contact-point velocity) is
    // what actually determines stopping power.
    const brakeLimit = wheel.brake;
    let forwardImpulse;
    if (brakeLimit > 0) {
      forwardImpulse = solveBilateralImpulse(chassisBody, groundBody?.mass > 0 ? groundBody : null, hitPoint, frictionForward, brakeLimit);
    } else {
      forwardImpulse = 0;
    }
    forwardImpulse += wheel.engineForce * dt;

    // Rolling resistance: a small, continuous drag opposing the wheel's
    // own rolling motion (Frr = Crr(v) * Fz, same formula real tyres
    // follow, with Crr growing with speed via rollingResistanceSpeedFactor
    // - see DEFAULT_WHEEL_OPTIONS above), present any time the wheel is
    // loaded and moving - unlike engine force/brake above, this always
    // acts regardless of throttle/brake input, which is what actually
    // makes a car coast to a stop on a flat road instead of rolling
    // forever (and lose top speed faster than a flat drag force would).
    // Capped at (not solved as) the impulse that would zero the wheel's
    // own forward speed, so it slows the car toward a stop rather than
    // ever reversing it in one step. The per-surface compound's
    // rollingResistanceMultiplier (surfaceCompounds.js) scales the
    // vehicle's own rollingResistance the same proportional way
    // frictionMultiplier scales frictionSlip above, so e.g. water/loose
    // ground costs every vehicle extra coasting drag without flattening
    // each vehicle's own tuning (a monster truck's knobbier tyres still
    // drag more than a rally car's on the same surface).
    if (wheel.rollingResistance > 0) {
      chassisBody.getVelocityAtWorldPoint(hitPoint, velAtPoint1);
      const rollSpeed = frictionForward.dot(velAtPoint1);
      const denom = impulseDenominator(chassisBody, hitPoint, frictionForward);
      if (denom > 1e-9 && rollSpeed !== 0) {
        const stopImpulse = -rollSpeed / denom; // impulse needed to zero rollSpeed
        const effectiveRollingResistance = wheel.rollingResistance * compound.rollingResistanceMultiplier;
        const speedDependentCrr = effectiveRollingResistance * (1 + wheel.rollingResistanceSpeedFactor * Math.abs(rollSpeed));
        const maxResistImpulse = speedDependentCrr * wheel.suspensionForce * dt;
        const resistImpulse = Math.sign(stopImpulse) * Math.min(Math.abs(stopImpulse), maxResistImpulse);
        forwardImpulse += resistImpulse;
      }
    }

    // Lateral: fully cancel sideways slip at the contact patch (grippy
    // cornering), clamped below by the shared friction circle.
    let sideImpulse = solveBilateralImpulse(chassisBody, groundBody?.mass > 0 ? groundBody : null, hitPoint, frictionAxle, maxGrip);

    const combined = Math.hypot(forwardImpulse, sideImpulse);
    // How much of this wheel's available grip the current demand is using
    // (0 = unloaded, 1 = right at the limit/sliding) - exposed purely for
    // debug visuals (see hud/suspensionHud.js's green->red gradient),
    // doesn't feed back into the physics at all.
    wheel.gripFraction = maxGrip > 0 ? Math.min(1, combined / maxGrip) : 0;
    if (combined > maxGrip && combined > 0) {
      wheel.sliding = true;
      const scale = maxGrip / combined;
      forwardImpulse *= scale;
      sideImpulse *= scale;
    }

    hitPoint.vsub(chassisBody.position, frictionRelPos);

    if (forwardImpulse !== 0) {
      frictionForward.scale(forwardImpulse, frictionImpulseVec);
      // Reduced lever arm (file header point 3) - resists wheelie pitch
      // without touching the forward push itself.
      chassisBody.vectorToLocalFrame(frictionRelPos, frictionRelPosLocal);
      frictionRelPosLocal.y *= wheel.pitchInfluence;
      chassisBody.vectorToWorldFrame(frictionRelPosLocal, frictionRelPosScaled);
      chassisBody.applyImpulse(frictionImpulseVec, frictionRelPosScaled);
    }

    if (sideImpulse !== 0) {
      frictionAxle.scale(sideImpulse, frictionImpulseVec);
      chassisBody.vectorToLocalFrame(frictionRelPos, frictionRelPosLocal);
      frictionRelPosLocal.y *= wheel.rollInfluence;
      chassisBody.vectorToWorldFrame(frictionRelPosLocal, frictionRelPosScaled);
      chassisBody.applyImpulse(frictionImpulseVec, frictionRelPosScaled);

      if (groundBody && groundBody.mass > 0) {
        hitPoint.vsub(groundBody.position, frictionRelPos2);
        frictionImpulseVec.scale(-1, frictionImpulseVec);
        groundBody.applyImpulse(frictionImpulseVec, frictionRelPos2);
      }
    }

    // --- Visual wheel spin ---
    // Approximates real rolling: spins to match the actual ground-contact
    // speed along the wheel's forward axis, with a touch of free-spin
    // under wide-open engine force while sliding/airborne so a stuck
    // throttle still visibly spins the wheel.
    chassisBody.getVelocityAtWorldPoint(wheel.connectionPointWorld, velAtPoint1);
    const rollSpeed = frictionForward.dot(velAtPoint1);
    let deltaRotation = (-rollSpeed * dt) / wheel.radius;
    if ((wheel.sliding || !wheel.isInContact) && wheel.engineForce !== 0 && wheel.useCustomSlidingRotationalSpeed) {
      deltaRotation = (wheel.engineForce > 0 ? 1 : -1) * wheel.customSlidingRotationalSpeed * dt;
    }
    if (Math.abs(wheel.brake) > Math.abs(wheel.engineForce)) deltaRotation = 0;
    wheel.rotation += deltaRotation;

    // Forward-axis slip speed of the contact patch itself (m/s, signed):
    // rollSpeed is how fast the *car* is actually moving along the
    // wheel's forward axis, while (deltaRotation/dt)*radius is how fast
    // this step's wheel spin says the tyre surface is moving at the
    // contact patch - added together (not subtracted) since
    // deltaRotation is defined with the opposite sign convention to
    // rollSpeed (see the no-slip case above, where it exactly cancels
    // rollSpeed out to zero). Zero when rolling without slip; nonzero -
    // and typically large - under wheelspin/lockup, when the free-spin
    // deltaRotation above no longer tracks the car's actual rollSpeed at
    // all.
    wheel.spinSlipSpeed = rollSpeed + (deltaRotation / dt) * wheel.radius;
  }

  function updateVehicle(dt) {
    const wheelInfos = vehicle.wheelInfos;
    for (let i = 0; i < wheelInfos.length; i++) castRay(wheelInfos[i]);
    for (let i = 0; i < wheelInfos.length; i++) updateWheelTransform(i);
    for (let i = 0; i < wheelInfos.length; i++) applySuspension(wheelInfos[i], dt);
    for (let i = 0; i < wheelInfos.length; i++) applyFriction(wheelInfos[i], dt);

    vehicle.numWheelsOnGround = wheelInfos.reduce((n, w) => n + (w.isInContact ? 1 : 0), 0);
  }

  function addToWorld(world) {
    world.addBody(chassisBody);
    vehicle.world = world;
    vehicle.preStepCallback = () => updateVehicle(world.dt || 1 / 60);
    world.addEventListener('preStep', vehicle.preStepCallback);
  }

  function removeFromWorld(world) {
    world.removeBody(chassisBody);
    world.removeEventListener('preStep', vehicle.preStepCallback);
    vehicle.world = null;
  }

  vehicle.addWheel = addWheel;
  vehicle.setSteeringValue = setSteeringValue;
  vehicle.applyEngineForce = applyEngineForce;
  vehicle.setBrake = setBrake;
  vehicle.updateWheelTransform = updateWheelTransform;
  vehicle.addToWorld = addToWorld;
  vehicle.removeFromWorld = removeFromWorld;

  return vehicle;
}
