import * as CANNON from 'cannon-es';
import { getSurfaceCompound, DEFAULT_SURFACE_KEY, REFERENCE_TYRE_WIDTH_M } from './surfaceCompounds.js';
import { sampleImperfection } from './surfaceImperfections.js';
import {
  initTyre,
  tyreGrip,
  tyreRollingResistance,
  wearTyre,
  strikeTyre,
  punctureTyre,
  repairTyre,
  freshWarmTyre,
  inflateTyre,
  rimLump,
  updateCondition,
  conditionState,
  setConditionState,
} from './tyres.js';
import { initShock, strikeShock, noteShockLoad, endShockStrike, repairShock, setShockHealth } from './shocks.js';

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
//  5. Each wheel carries its own spin (tread speed + rotational inertia,
//     plus the engine's reflected inertia on driven wheels): it free-spins
//     in the air, spins up / locks when the patch exceeds static grip, and
//     then slides with the surface's lower dynamic friction.
//  6. Tyres wear and puncture (tyres.js); a flat runs on its rim. Their compound,
//     temperature, dirt and water scale grip (tyres/).
const UP_LOCAL = new CANNON.Vec3(0, 1, 0);

const DEFAULT_WHEEL_OPTIONS = {
  directionLocal: new CANNON.Vec3(0, -1, 0),
  axleLocal: new CANNON.Vec3(-1, 0, 0),
  chassisConnectionPointLocal: new CANNON.Vec3(0, 0, 0),
  maxSuspensionForce: 1e6, // car.js passes a mass-derived cap
  frictionSlip: 1.6, // static tyre mu (sticky tarmac)
  width: REFERENCE_TYRE_WIDTH_M, // tyre tread width (m), scales grip per surface
  sidewallHeight: 0.1, // tyre width * profile (m), soaks up surface bumps
  rollingResistance: 0.015, // Crr at low speed (asphalt)
  // Crr(v) = rollingResistance * (1 + factor * |v|), v in m/s.
  rollingResistanceSpeedFactor: 0.02,
  // Long-slip weight under power wheelspin (see LONG_SLIP_WEIGHT): higher =
  // spinning driven tyres give up more cornering grip (power oversteer).
  spinSlipWeight: 0.7,
  slideGripScale: 1, // share of the surface's dynamic grip kept while sliding
  rollInfluence: 0.09, // share of the lateral impulse's lever arm kept
  pitchInfluence: 0.65, // share of the forward impulse's lever arm kept
  // Ray starts this far above the attachment point, so a wheel whose mount sank
  // into the ground (belly contact, tunnel-guard snap, sharp crest) still finds it.
  rayStartHeight: 0.6,
};

// Tyre + rim mass ~ density * r^2 * width (17 kg for a 225/35 R17), and
// I ~ 0.7 m r^2, so the tread-equivalent spin mass I/r^2 = 0.7 m.
const WHEEL_MASS_PER_R2_WIDTH = 700;
const WHEEL_INERTIA_SHAPE = 0.7;
const MIN_SPIN_MASS = 4; // kg, keeps tiny wheels numerically sane
// Weight of spin/lock slip vs sideways slip when splitting dynamic grip:
// real tyres keep more cornering force under wheelspin than pure Coulomb.
const LONG_SLIP_WEIGHT = 0.25;
// A handbrake-locked tyre gives up more cornering grip, so the rear swings out.
const HANDBRAKE_LONG_SLIP_WEIGHT = 1;
const HANDBRAKE_DYNAMIC_GRIP = 0.7;
// Over-limit tyres only slide (dynamic grip) past this slip; below it they hold
// static grip at a slip angle. Thresholds scale with patch speed (peak slip
// angle in rad, peak slip ratio), with a floor in m/s for low speeds.
const PEAK_SLIP_ANGLE = 0.4;
const PEAK_SLIP_RATIO = 0.15;
const MIN_SLIDE_SLIP_SPEED = 0.5;
// A sliding tyre regrips only below this share of the slide threshold.
const REGRIP_SLIP_SHARE = 0.7;
// Bearing/air drag on a wheel spinning in the air, 1/s.
const AIR_SPIN_DRAG_PER_S = 0.4;
// Surface bumps only on ground this flat (hit normal's y); walls/kerbs stay exact.
const IMPERFECTION_MIN_NORMAL_Y = 0.7;
// Share of the sidewall height that flattens bumps (subtracted from their peak-to-peak).
const SIDEWALL_BUMP_ABSORPTION = 0.2;
// Share of the suspension travel (from full compression) where a hit can pop the tyre.
const BUMP_STOP_ZONE = 0.15;

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

/** Moves `x` toward 0 by at most `step` (never past it). */
function approachZero(x, step) {
  if (x > 0) return Math.max(0, x - step);
  if (x < 0) return Math.min(0, x + step);
  return 0;
}

/**
 * Raycast suspension (spring+damper) plus a friction-circle tyre model
 * (longitudinal + lateral grip limited by load x surface mu x tyre width,
 * static until exceeded, dynamic while sliding) and per-wheel spin.
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

  /** `options.body`: the rigid body this wheel is mounted on (default the chassis; a trailer's wheels pass the trailer). */
  function addWheel(options = {}) {
    const wheel = {
      ...DEFAULT_WHEEL_OPTIONS,
      body: chassisBody,
      ...options,
      steering: 0,
      engineForce: 0,
      brake: 0,
      abs: false,
      brakeGripCap: Infinity, // share of static grip the brake may use (pedal ramp); Infinity = can lock
      absActive: false, // ABS trimmed this wheel's brake in the last step (dash lamp)
      handbrake: false,
      rotation: 0,
      // Tread speed (m/s) along forwardWorld; equals the patch speed when
      // rolling cleanly. Negative = rolling forward (forwardWorld points back).
      spinSpeed: 0,
      // Driveline state, set each frame by input.js via setDriveline.
      drivelineMass: 0, // engine inertia reflected to this tread (kg)
      driveSpeedLimit: Infinity, // rev limiter as tread speed (m/s)
      engineBrake: 0, // engine-braking force (N)
      suspensionLength: 0,
      suspensionForce: 0,
      closingSpeed: 0, // suspension compression rate (m/s, + = compressing), last step
      nearBumpStop: false, // last step's raw suspension length within BUMP_STOP_ZONE of full compression
      groundRise: 0, // m the unclamped suspension length shrank since the last step
      prevRawLength: null,
      isInContact: false,
      sliding: false,
      wheelspin: false, // sliding because the drive overruns the patch (vs. sideways/locked)
      // Signed contact-patch slip along the wheel's forward axis (m/s);
      // nonzero under wheelspin/lockup. Used by smoke/dust effects.
      spinSlipSpeed: 0,
      sideSlipSpeed: 0, // contact-patch slip along the axle (m/s) while sliding
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
    if (wheel.spinMass === undefined) {
      const r2w = wheel.radius * wheel.radius * wheel.width;
      wheel.spinMass = Math.max(MIN_SPIN_MASS, WHEEL_INERTIA_SHAPE * WHEEL_MASS_PER_R2_WIDTH * r2w);
    }
    initTyre(wheel);
    initShock(wheel);
    vehicle.wheelInfos.push(wheel);
    return vehicle.wheelInfos.length - 1;
  }

  function setSteeringValue(value, i) {
    vehicle.wheelInfos[i].steering = value;
  }
  function applyEngineForce(value, i) {
    vehicle.wheelInfos[i].engineForce = value;
  }
  /** `abs`: the brake backs off rather than lock the wheel (pedal brake; not the handbrake). */
  function setBrake(value, i, abs = false, handbrake = false, gripCap = Infinity) {
    vehicle.wheelInfos[i].brake = value;
    vehicle.wheelInfos[i].abs = abs;
    vehicle.wheelInfos[i].brakeGripCap = gripCap;
    vehicle.wheelInfos[i].handbrake = handbrake;
  }
  /** Engine coupling of a driven wheel: reflected inertia (kg at the tread), rev-limit tread speed, engine braking (N). */
  function setDriveline(i, { mass = 0, speedLimit = Infinity, engineBrake = 0 }) {
    const wheel = vehicle.wheelInfos[i];
    wheel.drivelineMass = mass;
    wheel.driveSpeedLimit = speedLimit;
    wheel.engineBrake = engineBrake;
  }
  /** Stops every wheel spinning (teleports/resets). */
  function resetWheelSpin() {
    for (const wheel of vehicle.wheelInfos) wheel.spinSpeed = 0;
  }
  /** Fresh tyres on every wheel. */
  function repairTyres() {
    for (const wheel of vehicle.wheelInfos) repairTyre(wheel);
  }
  /** Fresh tyres on every wheel, warmed close to their working temperature. */
  function fitWarmTyres() {
    for (const wheel of vehicle.wheelInfos) freshWarmTyre(wheel);
  }
  /** Fresh shock absorbers on every wheel. */
  function repairShocks() {
    for (const wheel of vehicle.wheelInfos) repairShock(wheel);
  }
  /** Per-wheel shock health, for the save. */
  function getShockState() {
    return vehicle.wheelInfos.map((w) => w.shockHealth);
  }
  function setShockState(state) {
    if (!Array.isArray(state) || state.length !== vehicle.wheelInfos.length) return;
    state.forEach((health, i) => {
      if (Number.isFinite(health)) setShockHealth(vehicle.wheelInfos[i], health);
    });
  }
  /** Per-wheel [{ tread, punctured, tempC, dirt, wetness }], for the save. */
  function getTyreState() {
    return vehicle.wheelInfos.map((w) => ({ tread: w.tread, punctured: w.punctured, ...conditionState(w) }));
  }
  /** `parkedS`: time since the state was saved, the tyres cool meanwhile. */
  function setTyreState(state, parkedS = 0) {
    if (!Array.isArray(state) || state.length !== vehicle.wheelInfos.length) return;
    state.forEach((s, i) => {
      const wheel = vehicle.wheelInfos[i];
      repairTyre(wheel);
      if (Number.isFinite(s?.tread)) wheel.tread = Math.min(1, Math.max(0, s.tread));
      if (s?.punctured === true) punctureTyre(wheel);
      setConditionState(wheel, s, parkedS);
    });
  }
  // Called with the wheel index when a tyre pops (sound).
  vehicle.onTyrePop = null;
  function popTyre(wheel) {
    punctureTyre(wheel);
    vehicle.onTyrePop?.(vehicle.wheelInfos.indexOf(wheel));
  }
  // Debug HUD: pop / reinflate one tyre by index.
  vehicle.popTyre = (i) => {
    const wheel = vehicle.wheelInfos[i];
    if (wheel && !wheel.punctured) popTyre(wheel);
  };
  vehicle.inflateTyre = (i) => {
    const wheel = vehicle.wheelInfos[i];
    if (wheel) inflateTyre(wheel);
  };

  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const rayResult = new CANNON.RaycastResult();
  // Extra bodies of this rig the suspension rays must ignore (e.g. car.js's
  // wheel hitboxes, which sit right on the ray). Filled by the caller.
  vehicle.ignoreBodies = [];
  // Local -> network frame for the surface bumps: net = (ox + sx * x, oz + z).
  // Set each frame by mainLoop (the view frame moves with floating origin).
  vehicle.imperfectionFrame = { ox: 0, oz: 0, sx: 1 };

  /** Raises the hit by the surface's pseudo-random bump (flat steps, so the normal stays). */
  function applySurfaceImperfection(wheel) {
    const surfaceM = (getSurfaceCompound(wheel.surface).imperfectionCm ?? 0) / 100;
    const amplitudeM = surfaceM - wheel.sidewallHeight * SIDEWALL_BUMP_ABSORPTION;
    const hit = wheel.raycastResult;
    const normal = hit.hitNormalWorld;
    if (amplitudeM <= 0 || normal.y < IMPERFECTION_MIN_NORMAL_Y || hit.body?.mass > 0) return;
    const { ox, oz, sx } = vehicle.imperfectionFrame;
    const point = hit.hitPointWorld;
    const bumpHeight = sampleImperfection(ox + sx * point.x, oz + point.z, amplitudeM);

    // A vertical rise h moves the plane h * n.y along n, i.e. that / (-n.d) along the ray.
    const along = Math.max(0.3, -normal.dot(wheel.directionWorld));
    const shorten = (bumpHeight * normal.y) / along;
    hit.distance -= shorten;
    point.x -= wheel.directionWorld.x * shorten;
    point.y -= wheel.directionWorld.y * shorten;
    point.z -= wheel.directionWorld.z * shorten;
  }

  /** A flat tyre's once-per-revolution thump (along the ray, like a bump). */
  function applyRimLump(wheel) {
    const lump = rimLump(wheel);
    if (lump <= 0 || wheel.raycastResult.hitNormalWorld.y < IMPERFECTION_MIN_NORMAL_Y) return;
    const hit = wheel.raycastResult;
    hit.distance -= lump;
    hit.hitPointWorld.x -= wheel.directionWorld.x * lump;
    hit.hitPointWorld.y -= wheel.directionWorld.y * lump;
    hit.hitPointWorld.z -= wheel.directionWorld.z * lump;
  }

  function castRay(wheel) {
    const body = wheel.body;
    body.pointToWorldFrame(wheel.chassisConnectionPointLocal, wheel.connectionPointWorld);
    body.vectorToWorldFrame(wheel.directionLocal, wheel.directionWorld);
    body.vectorToWorldFrame(wheel.axleLocal, wheel.axleWorld);

    const rayStart = wheel.rayStartHeight;
    const rayLength = rayStart + wheel.suspensionRestLength + wheel.maxSuspensionTravel + wheel.radius;
    wheel.directionWorld.scale(-rayStart, rayFrom);
    rayFrom.vadd(wheel.connectionPointWorld, rayFrom);
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

    if (rayResult.hasHit && rayResult.body !== body) {
      wheel.isInContact = true;
      wheel.raycastResult.body = rayResult.body;
      wheel.raycastResult.hitPointWorld.copy(rayResult.hitPointWorld);
      wheel.raycastResult.hitNormalWorld.copy(rayResult.hitNormalWorld);
      wheel.raycastResult.distance = rayResult.distance;
      applySurfaceImperfection(wheel);
      applyRimLump(wheel);
      wheel.raycastResult.distance -= rayStart; // measured from the attachment point again

      let length = wheel.raycastResult.distance - wheel.radius;
      // Near the bump stop a hit goes into the tyre itself (crushed against the rim).
      wheel.nearBumpStop = length < minLength + (maxLength - minLength) * BUMP_STOP_ZONE;
      wheel.groundRise = wheel.prevRawLength === null ? 0 : wheel.prevRawLength - length;
      wheel.prevRawLength = length;
      if (length < minLength) length = minLength;
      if (length > maxLength) length = maxLength;
      wheel.suspensionLength = length;
    } else {
      wheel.isInContact = false;
      wheel.raycastResult.body = null;
      wheel.suspensionLength = maxLength;
      wheel.nearBumpStop = false;
      wheel.prevRawLength = null;
    }
  }

  const steeringOrn = new CANNON.Quaternion();
  const rotatingOrn = new CANNON.Quaternion();
  function updateWheelTransform(i) {
    const wheel = vehicle.wheelInfos[i];
    const body = wheel.body;
    body.pointToWorldFrame(wheel.chassisConnectionPointLocal, wheel.connectionPointWorld);
    body.vectorToWorldFrame(wheel.directionLocal, wheel.directionWorld);
    body.vectorToWorldFrame(wheel.axleLocal, wheel.axleWorld);

    steeringOrn.setFromAxisAngle(UP_LOCAL, wheel.steering + wheel.rimToe);
    rotatingOrn.setFromAxisAngle(rightAxisLocal, wheel.rotation);
    body.quaternion.mult(steeringOrn, wheel.worldTransform.quaternion);
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
      wheel.closingSpeed = 0;
      endShockStrike(wheel);
      return;
    }
    const lengthDiff = wheel.suspensionRestLength - wheel.suspensionLength; // + = compressed
    const body = wheel.body;
    const chassisMass = body.mass;

    body.getVelocityAtWorldPoint(wheel.raycastResult.hitPointWorld, velAtPoint1);
    const closingSpeed = -wheel.raycastResult.hitNormalWorld.dot(velAtPoint1); // + = compressing
    wheel.closingSpeed = closingSpeed;

    const damping = closingSpeed > 0 ? wheel.dampingCompression : wheel.dampingRelaxation;
    let force = wheel.suspensionStiffness * lengthDiff * chassisMass + damping * closingSpeed * chassisMass;
    if (force < 0) force = 0;
    if (force > wheel.maxSuspensionForce) force = wheel.maxSuspensionForce;
    wheel.suspensionForce = force;

    wheel.raycastResult.hitNormalWorld.scale(force * dt, suspensionImpulse);
    wheel.raycastResult.hitPointWorld.vsub(body.position, suspensionRelPos);
    body.applyImpulse(suspensionImpulse, suspensionRelPos);
    if (body.type !== CANNON.Body.DYNAMIC) return;
    const strike = strikeSpeed(wheel, closingSpeed, dt);
    noteShockLoad(wheel, strike);
    if (wheel.nearBumpStop) checkRimStrike(wheel, strike);
    else endShockStrike(wheel);
  }

  /**
   * Strike speed: the chassis closing on the ground, or the ground rising
   * under the wheel (kerb, rock) - a step of height h met at speed v rises
   * over about one tyre radius, so ~v * h / r (and never faster than one step).
   */
  function strikeSpeed(wheel, closingSpeed, dt) {
    const rise = Math.max(0, wheel.groundRise);
    const speed = wheel.body.velocity.length();
    const kerbSpeed = Math.min(rise / dt, (speed * rise) / wheel.inflatedRadius);
    return Math.max(closingSpeed, kerbSpeed);
  }

  /** Bump-stop strike: wears the shock and may pop the tyre. */
  function checkRimStrike(wheel, strike) {
    strikeShock(wheel, strike);
    if (strikeTyre(wheel, strike, getSurfaceCompound(wheel.surface))) popTyre(wheel);
  }

  // --- Tyre friction: forward (engine/brake via the wheel's spin) + lateral
  // (cornering), combined in one friction circle. Static grip holds until
  // exceeded, then the patch slides at the lower dynamic grip ---
  const frictionForward = new CANNON.Vec3();
  const frictionAxle = new CANNON.Vec3();
  const frictionNormalScaledProj = new CANNON.Vec3();
  const frictionRelPos = new CANNON.Vec3();
  const frictionRelPosLocal = new CANNON.Vec3();
  const frictionRelPosScaled = new CANNON.Vec3();
  const frictionImpulseVec = new CANNON.Vec3();
  const frictionRelPos2 = new CANNON.Vec3();
  const patchVel = new CANNON.Vec3();
  const groundVel = new CANNON.Vec3();

  /** Impulse on the chassis at the contact patch with a reduced lever arm (+ reaction on a dynamic ground body). */
  function applyPatchImpulse(wheel, dir, impulse, leverInfluence, groundBody) {
    if (impulse === 0) return;
    const body = wheel.body;
    const hitPoint = wheel.raycastResult.hitPointWorld;
    hitPoint.vsub(body.position, frictionRelPos);
    dir.scale(impulse, frictionImpulseVec);
    body.vectorToLocalFrame(frictionRelPos, frictionRelPosLocal);
    frictionRelPosLocal.y *= leverInfluence;
    body.vectorToWorldFrame(frictionRelPosLocal, frictionRelPosScaled);
    body.applyImpulse(frictionImpulseVec, frictionRelPosScaled);
    if (groundBody) {
      hitPoint.vsub(groundBody.position, frictionRelPos2);
      frictionImpulseVec.scale(-1, frictionImpulseVec);
      groundBody.applyImpulse(frictionImpulseVec, frictionRelPos2);
    }
  }

  /** Mount body's velocity at the patch relative to the ground, into patchVel. */
  function readPatchVelocity(body, hitPoint, groundBody) {
    body.getVelocityAtWorldPoint(hitPoint, patchVel);
    if (groundBody) {
      groundBody.getVelocityAtWorldPoint(hitPoint, groundVel);
      patchVel.vsub(groundVel, patchVel);
    }
  }

  function applyFriction(wheel, dt) {
    const wasSliding = wheel.sliding;
    wheel.sliding = false;
    wheel.wheelspin = false;
    wheel.gripFraction = 0;
    const spinMass = wheel.spinMass + wheel.drivelineMass;
    // Drive impulse on the tread; none once at the rev limit in that direction.
    let drive = wheel.engineForce * dt;
    if (drive !== 0 && Math.sign(drive) * wheel.spinSpeed >= wheel.driveSpeedLimit) drive = 0;
    // Brake (impulse cap per step, like cannon-es) + engine braking.
    const brakeLimit = wheel.brake + wheel.engineBrake * dt;
    const wDrive = wheel.spinSpeed + drive / spinMass;

    let w;
    wheel.absActive = false;
    if (!wheel.isInContact) {
      w = approachZero(wDrive * (1 - Math.min(1, AIR_SPIN_DRAG_PER_S * dt)), brakeLimit / spinMass);
      wheel.spinSlipSpeed = 0;
      wheel.sideSlipSpeed = 0;
      updateCondition(wheel, null, 0, 0, 0, dt);
    } else {
      w = applyGroundFriction(wheel, dt, spinMass, wDrive, brakeLimit, wasSliding);
    }
    if (drive !== 0 && Math.sign(drive) * w > wheel.driveSpeedLimit) w = Math.sign(drive) * wheel.driveSpeedLimit;
    wheel.spinSpeed = w;
    wheel.rotation += (-w * dt) / wheel.radius;
  }

  /** Grounded tyre solve; applies the patch impulses and returns the new tread speed. */
  function applyGroundFriction(wheel, dt, spinMass, wDrive, brakeLimit, wasSliding) {
    const body = wheel.body;
    const groundBody = wheel.raycastResult.body?.mass > 0 ? wheel.raycastResult.body : null;
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

    // Surface compound sets static mu, its dynamic share and how tyre width
    // pays off; maxForceN caps grip regardless of load.
    const compound = getSurfaceCompound(wheel.surface);
    const staticMu = wheel.frictionSlip * compound.frictionMultiplier;
    const widthGrip = Math.pow(wheel.width / REFERENCE_TYRE_WIDTH_M, compound.widthGripExponent ?? 0);
    const staticGrip = Math.min(wheel.suspensionForce * staticMu * widthGrip, compound.maxForceN) * tyreGrip(wheel) * dt;
    const dynamicGrip = staticGrip * (compound.dynamicFrictionRatio ?? 1);

    // Rolling resistance Frr = Crr(v) * Fz on the chassis, capped at the
    // impulse that would stop it (never reverses it).
    if (wheel.rollingResistance > 0) {
      readPatchVelocity(body, hitPoint, groundBody);
      const rollSpeed = frictionForward.dot(patchVel);
      const denom = impulseDenominator(body, hitPoint, frictionForward);
      if (denom > 1e-9 && rollSpeed !== 0) {
        const stopImpulse = -rollSpeed / denom;
        const effectiveRollingResistance = wheel.rollingResistance * compound.rollingResistanceMultiplier * tyreRollingResistance(wheel);
        const speedDependentCrr = effectiveRollingResistance * (1 + wheel.rollingResistanceSpeedFactor * Math.abs(rollSpeed));
        const maxResistImpulse = speedDependentCrr * wheel.suspensionForce * dt;
        const resistImpulse = Math.sign(stopImpulse) * Math.min(Math.abs(stopImpulse), maxResistImpulse);
        applyPatchImpulse(wheel, frictionForward, resistImpulse, wheel.pitchInfluence, null);
      }
    }

    readPatchVelocity(body, hitPoint, groundBody);
    const vLong = frictionForward.dot(patchVel);
    const vLat = frictionAxle.dot(patchVel);
    const denomLong =
      impulseDenominator(body, hitPoint, frictionForward) +
      (groundBody ? impulseDenominator(groundBody, hitPoint, frictionForward) : 0);
    const chassisMass = denomLong > 1e-9 ? 1 / denomLong : 0;

    // Rolling solution: chassis and tread end at a common speed u, with the
    // brake pulling that shared momentum toward 0 as far as its cap allows.
    const momentum = chassisMass * vLong + spinMass * wDrive;
    const totalMass = chassisMass + spinMass;
    let brakeImpulse = Math.max(-brakeLimit, Math.min(brakeLimit, -momentum));
    let longRoll = chassisMass * ((momentum + brakeImpulse) / totalMass - vLong);
    const sideRoll = solveBilateralImpulse(body, groundBody, hitPoint, frictionAxle, Infinity);
    // ABS / pedal grip cap: trim the brake so the patch stays within that share of static grip.
    const gripCap = wheel.abs ? Math.min(1, wheel.brakeGripCap) : wheel.brakeGripCap;
    const longAvail = Math.sqrt(Math.max(0, staticGrip * staticGrip - sideRoll * sideRoll)) * gripCap;
    if (gripCap !== Infinity && brakeImpulse !== 0 && Math.abs(longRoll) > longAvail) {
      const brakeShare = chassisMass / totalMass; // d(longRoll)/d(brakeImpulse)
      const target = Math.sign(longRoll) * longAvail;
      const trimmed = brakeImpulse + (target - longRoll) / brakeShare;
      brakeImpulse = Math.sign(trimmed) === Math.sign(brakeImpulse) ? trimmed : 0;
      longRoll = chassisMass * ((momentum + brakeImpulse) / totalMass - vLong);
      brakeLimit = Math.abs(brakeImpulse);
      wheel.absActive = wheel.abs && gripCap >= 1; // lamp only for ABS proper, not the pedal ramp
    }
    const u = (momentum + brakeImpulse) / totalMass;
    const needed = Math.hypot(longRoll, sideRoll);
    wheel.gripFraction = staticGrip > 0 ? Math.min(1, needed / staticGrip) : 1; // debug HUD only

    const wFree = approachZero(wDrive, brakeLimit / spinMass);
    // Patch slip relative to the slide threshold (1 = at the limit).
    const latThreshold = Math.max(MIN_SLIDE_SLIP_SPEED, Math.abs(vLong) * PEAK_SLIP_ANGLE);
    const longThreshold = Math.max(MIN_SLIDE_SLIP_SPEED, Math.abs(vLong) * PEAK_SLIP_RATIO);
    const slip = Math.hypot(vLat / latThreshold, (vLong - wFree) / longThreshold);

    let longImpulse, sideImpulse, w;
    if (needed <= staticGrip * (1 + 1e-6)) { // tolerance: ABS trims to exactly staticGrip
      longImpulse = longRoll;
      sideImpulse = sideRoll;
      w = u;
    } else if (slip < (wasSliding ? REGRIP_SLIP_SHARE : 1)) {
      // Over the limit for this step but barely slipping: full static grip
      // along the rolling solution, the rest carries over as slip angle.
      const scale = staticGrip / needed;
      longImpulse = longRoll * scale;
      sideImpulse = sideRoll * scale;
      w = approachZero(wDrive - longImpulse / spinMass, brakeLimit / spinMass);
    } else {
      // Sliding: dynamic grip opposes the patch slip direction, so a spinning
      // or locked wheel also loses most of its cornering grip.
      wheel.sliding = true;
      // Power wheelspin: the tread overruns the patch in the drive direction.
      const wheelspin = wheel.engineForce !== 0 && Math.sign(wFree - vLong) === Math.sign(wheel.engineForce);
      wheel.wheelspin = wheelspin;
      const slipWeight = wheel.handbrake ? HANDBRAKE_LONG_SLIP_WEIGHT : wheelspin ? wheel.spinSlipWeight : LONG_SLIP_WEIGHT;
      const slipLong = (vLong - wFree) * slipWeight;
      const slideGrip = dynamicGrip * wheel.slideGripScale * (wheel.handbrake ? HANDBRAKE_DYNAMIC_GRIP : 1);
      const slipMag = Math.hypot(slipLong, vLat);
      const dirLong = slipMag > 1e-3 ? slipLong / slipMag : -longRoll / needed;
      const dirLat = slipMag > 1e-3 ? vLat / slipMag : -sideRoll / needed;
      // Never more than the impulse that would end the slip (no overshoot).
      longImpulse = -dirLong * slideGrip;
      longImpulse = Math.sign(longImpulse) * Math.min(Math.abs(longImpulse), Math.abs(longRoll));
      sideImpulse = -dirLat * slideGrip;
      sideImpulse = Math.sign(sideImpulse) * Math.min(Math.abs(sideImpulse), Math.abs(sideRoll));
      w = approachZero(wDrive - longImpulse / spinMass, brakeLimit / spinMass);
    }

    applyPatchImpulse(wheel, frictionForward, longImpulse, wheel.pitchInfluence, null);
    applyPatchImpulse(wheel, frictionAxle, sideImpulse, wheel.rollInfluence, groundBody);

    // Patch speed minus tread speed: 0 when rolling cleanly.
    if (wheel.sliding) {
      readPatchVelocity(body, hitPoint, groundBody);
      wheel.spinSlipSpeed = frictionForward.dot(patchVel) - w;
      wheel.sideSlipSpeed = frictionAxle.dot(patchVel);
    } else {
      wheel.spinSlipSpeed = 0;
      wheel.sideSlipSpeed = 0;
    }
    if (body.type === CANNON.Body.DYNAMIC) {
      const slipSpeed = Math.hypot(wheel.spinSlipSpeed, wheel.sideSlipSpeed);
      const frictionImpulse = Math.hypot(longImpulse, sideImpulse);
      updateCondition(wheel, wheel.surface, frictionImpulse / dt, slipSpeed, vLong, dt);
      if (wearTyre(wheel, frictionImpulse, slipSpeed, vLong, compound, dt)) popTyre(wheel);
    }
    return w;
  }

  // Driven wheels in the air follow the grounded driven ones (diff/LSD), so
  // a hop doesn't flare one wheel to the limiter while the rest still grip.
  function coupleDrivenWheels() {
    const driven = vehicle.driveWheels;
    if (!driven || driven.length < 2) return;
    let sum = 0;
    let grounded = 0;
    for (const i of driven) {
      const wheel = vehicle.wheelInfos[i];
      if (wheel?.isInContact) {
        sum += wheel.spinSpeed;
        grounded++;
      }
    }
    if (grounded === 0 || grounded === driven.length) return;
    const mean = sum / grounded;
    for (const i of driven) {
      const wheel = vehicle.wheelInfos[i];
      if (wheel && !wheel.isInContact) wheel.spinSpeed = mean;
    }
  }

  function updateVehicle(dt) {
    const wheelInfos = vehicle.wheelInfos;
    for (let i = 0; i < wheelInfos.length; i++) castRay(wheelInfos[i]);
    for (let i = 0; i < wheelInfos.length; i++) updateWheelTransform(i);
    for (let i = 0; i < wheelInfos.length; i++) applySuspension(wheelInfos[i], dt);
    for (let i = 0; i < wheelInfos.length; i++) applyFriction(wheelInfos[i], dt);
    coupleDrivenWheels();

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
  vehicle.setDriveline = setDriveline;
  vehicle.resetWheelSpin = resetWheelSpin;
  vehicle.repairTyres = repairTyres;
  vehicle.fitWarmTyres = fitWarmTyres;
  vehicle.repairShocks = repairShocks;
  vehicle.getShockState = getShockState;
  vehicle.setShockState = setShockState;
  vehicle.getTyreState = getTyreState;
  vehicle.setTyreState = setTyreState;
  vehicle.updateWheelTransform = updateWheelTransform;
  vehicle.addToWorld = addToWorld;
  vehicle.removeFromWorld = removeFromWorld;

  return vehicle;
}

