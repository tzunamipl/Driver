import * as CANNON from 'cannon-es';
import { getSurfaceCompound, DEFAULT_SURFACE_KEY } from './surfaceCompounds.js';

// Raycast vehicle replacing CANNON.RaycastVehicle, with the same public
// surface (wheelInfos[], addWheel, setSteeringValue, applyEngineForce,
// setBrake, updateWheelTransform, addToWorld). Differences:
//  1. Suspension rays span the full travel, so wheels track dips/curbs
//     instead of popping.
//  2. Suspension force acts along the hit normal, so angled kerbs/walls
//     push the car sideways naturally.
//  3. Forward and lateral tyre impulses both use an effective-mass solve
//     and a reduced lever arm (pitch/rollInfluence), so no excess
//     wheelie/flip torque is generated in the first place.
//  4. Speed-dependent rolling resistance, so the car coasts to a stop.
const UP_LOCAL = new CANNON.Vec3(0, 1, 0);

const DEFAULT_WHEEL_OPTIONS = {
  directionLocal: new CANNON.Vec3(0, -1, 0),
  axleLocal: new CANNON.Vec3(-1, 0, 0),
  chassisConnectionPointLocal: new CANNON.Vec3(0, 0, 0),
  maxSuspensionForce: 1e6, // car.js passes a mass-derived cap
  frictionSlip: 1.6, // tyre mu (sticky tarmac)
  rollingResistance: 0.015, // Crr at low speed (asphalt)
  // Crr(v) = rollingResistance * (1 + factor * |v|), v in m/s.
  rollingResistanceSpeedFactor: 0.08,
  rollInfluence: 0.09, // share of the lateral impulse's lever arm kept
  pitchInfluence: 0.65, // share of the forward impulse's lever arm kept
  customSlidingRotationalSpeed: -30,
  useCustomSlidingRotationalSpeed: false,
};

function axisVec(index) {
  return index === 0 ? new CANNON.Vec3(1, 0, 0) : index === 1 ? new CANNON.Vec3(0, 1, 0) : new CANNON.Vec3(0, 0, 1);
}

// 1/m_eff = invMass + dir . ((invInertiaWorld . (r x dir)) x r), as in
// cannon-es's computeImpulseDenominator.
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
/** Impulse along `dir` that zeroes relative velocity at `pos`, clamped to ±maxImpulse. */
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
 * Raycast suspension (spring+damper) plus a friction-circle tyre model
 * (longitudinal + lateral grip limited by load x frictionSlip).
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
      // Signed contact-patch slip along the wheel's forward axis (m/s);
      // nonzero under wheelspin/lockup. Used by smoke/dust effects.
      spinSlipSpeed: 0,
      forwardWorld: new CANNON.Vec3(), // last contact-patch forward direction
      surface: DEFAULT_SURFACE_KEY, // set each frame by mainLoop's classifySurfaceAt
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
  // Extra bodies of this rig the suspension rays must ignore (e.g. car.js's
  // wheel hitboxes, which sit right on the ray). Filled by the caller.
  vehicle.ignoreBodies = [];
  function castRay(wheel) {
    chassisBody.pointToWorldFrame(wheel.chassisConnectionPointLocal, wheel.connectionPointWorld);
    chassisBody.vectorToWorldFrame(wheel.directionLocal, wheel.directionWorld);
    chassisBody.vectorToWorldFrame(wheel.axleLocal, wheel.axleWorld);

    const rayLength = wheel.suspensionRestLength + wheel.maxSuspensionTravel + wheel.radius;
    rayFrom.copy(wheel.connectionPointWorld);
    wheel.directionWorld.scale(rayLength, rayTo);
    rayTo.vadd(rayFrom, rayTo);

    rayResult.reset();
    // Disable collision response on our own bodies for this raycast only.
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

    // Steered axle/forward directions, projected onto the contact plane.
    wheel.worldTransform.quaternion.vmult(rightAxisLocal, frictionAxle);
    const proj = frictionAxle.dot(normal);
    normal.scale(proj, frictionNormalScaledProj);
    frictionAxle.vsub(frictionNormalScaledProj, frictionAxle);
    frictionAxle.normalize();
    normal.cross(frictionAxle, frictionForward);
    frictionForward.normalize();
    wheel.forwardWorld.copy(frictionForward);

    // Surface compound scales/offsets frictionSlip and caps grip force
    // independent of load (water stays slippery however loaded).
    const compound = getSurfaceCompound(wheel.surface);
    const effectiveFrictionSlip = Math.max(0, wheel.frictionSlip * compound.frictionMultiplier + compound.frictionSlipOffset);
    const rawGripForce = Math.min(wheel.suspensionForce * effectiveFrictionSlip, compound.maxForceN);
    const maxGrip = rawGripForce * dt;

    // Longitudinal: brake = velocity-zeroing impulse capped by wheel.brake
    // (not scaled by dt, like cannon-es), plus engine force.
    const brakeLimit = wheel.brake;
    let forwardImpulse;
    if (brakeLimit > 0) {
      forwardImpulse = solveBilateralImpulse(chassisBody, groundBody?.mass > 0 ? groundBody : null, hitPoint, frictionForward, brakeLimit);
    } else {
      forwardImpulse = 0;
    }
    forwardImpulse += wheel.engineForce * dt;

    // Rolling resistance Frr = Crr(v) * Fz, always on, capped at the impulse
    // that would stop the wheel (never reverses it).
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

    // Lateral: cancel sideways slip, limited by the friction circle.
    let sideImpulse = solveBilateralImpulse(chassisBody, groundBody?.mass > 0 ? groundBody : null, hitPoint, frictionAxle, maxGrip);

    const combined = Math.hypot(forwardImpulse, sideImpulse);
    wheel.gripFraction = maxGrip > 0 ? Math.min(1, combined / maxGrip) : 0; // debug HUD only
    if (combined > maxGrip && combined > 0) {
      wheel.sliding = true;
      const scale = maxGrip / combined;
      forwardImpulse *= scale;
      sideImpulse *= scale;
    }

    hitPoint.vsub(chassisBody.position, frictionRelPos);

    if (forwardImpulse !== 0) {
      frictionForward.scale(forwardImpulse, frictionImpulseVec);
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

    // Visual spin matches ground speed; free-spins under throttle while
    // sliding/airborne; stops under brake.
    chassisBody.getVelocityAtWorldPoint(wheel.connectionPointWorld, velAtPoint1);
    const rollSpeed = frictionForward.dot(velAtPoint1);
    let deltaRotation = (-rollSpeed * dt) / wheel.radius;
    if ((wheel.sliding || !wheel.isInContact) && wheel.engineForce !== 0 && wheel.useCustomSlidingRotationalSpeed) {
      deltaRotation = (wheel.engineForce > 0 ? 1 : -1) * wheel.customSlidingRotationalSpeed * dt;
    }
    if (Math.abs(wheel.brake) > Math.abs(wheel.engineForce)) deltaRotation = 0;
    wheel.rotation += deltaRotation;

    // Car speed + tread speed (opposite sign convention): 0 when rolling cleanly.
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

