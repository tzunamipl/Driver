// Terrain-dust particle effect: dry brown dust from two independent
// triggers, each with its own "where it comes from" rule:
//
//  1. Sliding: when a wheel is actually sliding (wheel.sliding, computed
//     every physics step by wheeledVehicle.js's friction-circle solve -
//     the same flag hud/suspensionHud.js's red wheel fill reflects, and
//     lib/tireSmoke.js's own road-smoke trigger), that wheel kicks out a
//     big puff of dust from its own position regardless of overall speed
//     - drifting/skidding throws up dirt right where the tyre is biting,
//     even at low speed.
//  2. Speed: once the chassis is moving faster than DUST_SPEED_KMH and at
//     least one wheel is grounded on normal ground, kicks up one smaller,
//     steadier trail puff from the chassis' own center (not per wheel -
//     a bigger gaps-between-puffs trail, not 4 separate ones) that gets
//     more frequent and more opaque (less see-through) the faster the
//     car goes, like a denser dust trail being thrown up at speed. Both
//     triggers share the same pool/particle look and can fire together
//     (e.g. drifting at speed).
//
// Deliberately simple - no real dirt/soil sim, just a pooled set of
// growing, fading spheres reused round-robin, matching
// lib/tireSmoke.js/lib/splash.js's own wheel-effect pattern (their doc
// comments cover the shared reasoning for this style).
//
// Gated on wheel.surface === 'normal' specifically (not road/water) since
// tyre smoke (lib/tireSmoke.js) already owns the paved-road sliding case
// and splash (lib/splash.js) already owns water - this is the remaining
// "plain ground" case those two deliberately exclude. Deliberately bigger
// and darker-brown than tireSmoke's grey/white puffs (see START_SCALE/
// SLIDE_END_SCALE/COLOR_MIN/COLOR_MAX below) so the two read as distinct
// materials - dry dirt vs scorched rubber - rather than the same effect
// recoloured.

import * as THREE from 'three';
import { isWheelGrounded } from './wheelContact.js';

// Pool sized generously above the worst-case concurrent-particle count
// (every wheel emitting a full sliding burst at once, plus the speed
// trigger's own single puff, at their fixed intervals, for a full
// particle lifetime) so a new puff never has to cut an older, still-
// visible one short.
const POOL_SIZE = 96;
const PARTICLE_LIFETIME_S = 0.9;
// Puff grows/drifts like tyre smoke and body-dust (real dust billows
// outward/up as it's kicked loose) rather than staying a fixed size like
// splash.js's ballistic droplets. Sized well above tireSmoke.js's
// START_SCALE/END_SCALE (0.12/0.55) so a dust puff visibly dwarfs a smoke
// puff even side by side.
const START_SCALE = 0.25;
// A "big puff" per emit for the sliding trigger - noticeably more
// particles per burst than tireSmoke.js's 2, so this reads as a
// billowing cloud kicked out from behind the wheel rather than a thin
// wisp.
const SLIDE_PARTICLES_PER_EMIT = 1;
const SLIDE_END_SCALE = 1.1;
const SLIDE_EMIT_INTERVAL_S = 0.08;
const SLIDE_BASE_OPACITY = 0.5;
const RISE_SPEED_MIN = 0.2;
const RISE_SPEED_MAX = 0.7;
const OUTWARD_SPEED_MIN = 0.5;
const OUTWARD_SPEED_MAX = 1.8;
const DRAG = 0.99; // multiplies velocity each second (exponential decay) - also what gradually stops the inherited chassis velocity below
// Puffs are kicked out from underneath a moving car, so they should carry
// some of its momentum rather than spawning dead-still relative to the
// ground - only a fraction though, so slow-speed sliding puffs still read
// as mostly outward/upward rather than being flung forward wholesale.
const VELOCITY_INHERIT_FRACTION = 0.1;
// How much of a sliding wheel's own forward-axis spin-slip speed
// (wheeledVehicle.js's wheel.spinSlipSpeed) gets added straight to the
// sliding-trigger puff's launch velocity, same reasoning as
// lib/tireSmoke.js's own SPIN_LAUNCH_FRACTION - a wheel overspinning
// faster than the car is actually moving (wheelspin) kicks dirt out
// behind it, not just along wherever the chassis happens to be going.
// Not applied to the speed trigger below since that one isn't gated on
// wheel.sliding/spin at all.
const SPIN_LAUNCH_FRACTION = 0.95;
// Clamp so an extreme free-spin speed can't fling a puff absurdly far.
const SPIN_LAUNCH_SPEED_MAX = 15;

// Single puff per emit for the speed trigger (comes from the chassis as
// a whole, not one per wheel), sized up a bit so it still reads clearly
// next to the sliding trigger's own per-wheel bursts.
const SPEED_END_SCALE_MIN = 2.1;
const SPEED_END_SCALE_MAX = 3.6;

// Speed trigger: below this chassis speed, no speed-based dust - only
// the sliding trigger above can still fire regardless of speed.
const DUST_SPEED_KMH = 50;
const DUST_SPEED_MS = DUST_SPEED_KMH / 3.6;
// Re-arm cooldown ranges from a long gap just above the threshold (slow,
// sparse puffs) down to a short one at/above this speed (frequent puffs
// at high speed).
const SPEED_EMIT_INTERVAL_MAX_S = 0.5;
const SPEED_EMIT_INTERVAL_MIN_S = 0.12;
const SPEED_FOR_MIN_INTERVAL_MS = 150 / 3.6;
// Opacity ranges from fairly see-through right at the threshold up to
// near-solid at/above SPEED_FOR_MIN_INTERVAL_MS, i.e. the faster the car
// goes the less transparent the dust trail looks.
const SPEED_OPACITY_MIN = 0.2;
const SPEED_OPACITY_MAX = 0.8;

const PARTICLE_GEO = new THREE.SphereGeometry(1, 6, 5);
// Saturated, darker brown than lib/bodyDust.js's tan/brown impact dust
// (which itself is lighter than this) so this reads unmistakably as
// "brown dirt" next to tireSmoke.js's pale grey/white smoke.
const COLOR_MIN = 0x5c3f23;
const COLOR_MAX = 0x8a5a2e;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Reused scratch object for the spin-slip velocity passed to spawnPuff
// each emit (avoids an allocation per puff/per wheel per frame).
const spinVelocityScratch = { x: 0, z: 0 };

/** Creates the terrain-dust effect. Call update() once per rendered frame (see app/mainLoop.js). */
export function createTerrainDust(scene) {
  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    // One material per pooled particle (not shared) since each fades its
    // own opacity independently, same tradeoff lib/tireSmoke.js makes for
    // its own per-particle state.
    const material = new THREE.MeshBasicMaterial({ color: COLOR_MIN, transparent: true, opacity: 0, depthWrite: false });
    const mesh = new THREE.Mesh(PARTICLE_GEO, material);
    mesh.visible = false;
    scene.add(mesh);
    pool.push({ mesh, material, velocity: new THREE.Vector3(), life: 0, baseOpacity: SLIDE_BASE_OPACITY, endScale: SLIDE_END_SCALE });
  }
  let nextSlot = 0;
  // One re-arm timer per wheel for the sliding trigger (resized lazily
  // the first time a vehicle with a different wheel count is seen,
  // mirroring lib/tireSmoke.js/lib/splash.js's own lazy per-wheel-count
  // rebuild) - but just one shared timer for the speed trigger, since
  // that one now spawns a single puff from the chassis as a whole, not
  // per wheel.
  let slideTimers = [];
  let speedTimer = 0;

  /**
   * @param {number} baseOpacity - this particle's starting opacity, remembered so the fade-out below scales off it rather than a single shared constant.
   * @param {number} endScale - this particle's final scale, remembered so the grow-over-life below scales off it rather than a single shared constant.
   * @param {{x: number, y: number, z: number}} [chassisVelocity] - current chassis velocity (m/s), partially inherited so puffs drift along with the car instead of spawning dead-still.
   * @param {{x: number, y: number, z: number}} [spinVelocity] - extra velocity (m/s) from the wheel's own forward-axis spin-slip (see wheeledVehicle.js's spinSlipSpeed), added on top so a wheel spinning faster than the car is moving actually launches dust in that direction instead of just drifting with the chassis.
   */
  function spawnPuff(x, y, z, baseOpacity, endScale, chassisVelocity, spinVelocity) {
    const p = pool[nextSlot];
    nextSlot = (nextSlot + 1) % POOL_SIZE;
    p.life = PARTICLE_LIFETIME_S;
    p.baseOpacity = baseOpacity;
    p.endScale = endScale;
    p.mesh.visible = true;
    p.mesh.scale.setScalar(START_SCALE);
    p.mesh.position.set(x, y, z);
    p.material.color.setHex(Math.random() < 0.5 ? COLOR_MIN : COLOR_MAX);
    p.material.opacity = baseOpacity;
    const angle = Math.random() * Math.PI * 2;
    const outSpeed = OUTWARD_SPEED_MIN + Math.random() * (OUTWARD_SPEED_MAX - OUTWARD_SPEED_MIN);
    p.velocity.set(
      Math.cos(angle) * outSpeed,
      RISE_SPEED_MIN + Math.random() * (RISE_SPEED_MAX - RISE_SPEED_MIN),
      Math.sin(angle) * outSpeed
    );
    if (chassisVelocity) {
      p.velocity.x += chassisVelocity.x * VELOCITY_INHERIT_FRACTION;
      p.velocity.z += chassisVelocity.z * VELOCITY_INHERIT_FRACTION;
    }
    if (spinVelocity) {
      p.velocity.x += spinVelocity.x;
      p.velocity.z += spinVelocity.z;
    }
  }

  /**
   * @param {number} dt - frame delta in seconds.
   * @param {object|null} vehicle - the active RaycastVehicle-like object (see wheeledVehicle.js), or null if no car is active yet.
   * @param {import('cannon-es').World|null} world
   */
  function update(dt, vehicle, world) {
    // Age/move every live particle regardless of whether a vehicle/wheel
    // check even runs this frame, so already-spawned puffs keep animating
    // smoothly.
    const dragFactor = Math.pow(DRAG, dt);
    for (const p of pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.visible = false;
        continue;
      }
      p.velocity.multiplyScalar(dragFactor);
      p.mesh.position.addScaledVector(p.velocity, dt);
      const t = 1 - p.life / PARTICLE_LIFETIME_S;
      p.mesh.scale.setScalar(START_SCALE + (p.endScale - START_SCALE) * t);
      p.material.opacity = p.baseOpacity * (1 - t);
    }

    if (!vehicle || !world) return;
    if (slideTimers.length !== vehicle.wheelInfos.length) {
      slideTimers = vehicle.wheelInfos.map(() => 0);
    }

    const speed = vehicle.chassisBody.velocity.length();
    const speedDustActive = speed >= DUST_SPEED_MS;
    const speedFrac = clamp((speed - DUST_SPEED_MS) / (SPEED_FOR_MIN_INTERVAL_MS - DUST_SPEED_MS), 0, 1);
    const speedInterval = SPEED_EMIT_INTERVAL_MAX_S - (SPEED_EMIT_INTERVAL_MAX_S - SPEED_EMIT_INTERVAL_MIN_S) * speedFrac;
    const speedOpacity = SPEED_OPACITY_MIN + (SPEED_OPACITY_MAX - SPEED_OPACITY_MIN) * speedFrac;
    const speedEndScale = SPEED_END_SCALE_MIN + (SPEED_END_SCALE_MAX - SPEED_END_SCALE_MIN) * speedFrac;

    speedTimer -= dt;
    // Only used by the speed trigger below (one puff from the chassis
    // center, not per wheel) - averages the grounded-normal wheels' own
    // ground height so that single puff still anchors near the ground
    // under the car rather than spawning at the chassis' own (much
    // higher) center height.
    let anyGroundedNormal = false;
    let groundYSum = 0;
    let groundYCount = 0;

    vehicle.wheelInfos.forEach((wheel, i) => {
      slideTimers[i] -= dt;
      if (wheel.surface !== 'normal') return;
      if (!isWheelGrounded(world, wheel)) return;
      const pos = wheel.worldTransform.position;
      const groundY = pos.y - wheel.radius * 0.9;
      anyGroundedNormal = true;
      groundYSum += groundY;
      groundYCount++;

      if (wheel.sliding && slideTimers[i] <= 0) {
        // Spin-slip speed is signed along the wheel's own forward axis
        // (wheel.forwardWorld) - negative when the tyre is overspinning
        // forward faster than the car is moving (the common wheelspin
        // case), which throws dust out behind the car rather than ahead
        // of it.
        const spinSpeed = clamp(wheel.spinSlipSpeed * SPIN_LAUNCH_FRACTION, -SPIN_LAUNCH_SPEED_MAX, SPIN_LAUNCH_SPEED_MAX);
        spinVelocityScratch.x = wheel.forwardWorld.x * spinSpeed;
        spinVelocityScratch.z = wheel.forwardWorld.z * spinSpeed;
        for (let n = 0; n < SLIDE_PARTICLES_PER_EMIT; n++) {
          spawnPuff(pos.x, groundY, pos.z, SLIDE_BASE_OPACITY, SLIDE_END_SCALE, vehicle.chassisBody.velocity, spinVelocityScratch);
        }
        slideTimers[i] = SLIDE_EMIT_INTERVAL_S;
      }
    });

    if (anyGroundedNormal && speedDustActive && speedTimer <= 0) {
      const chassisPos = vehicle.chassisBody.position;
      spawnPuff(chassisPos.x, groundYSum / groundYCount, chassisPos.z, speedOpacity, speedEndScale, vehicle.chassisBody.velocity);
      speedTimer = speedInterval;
    }
  }

  return { update };
}
