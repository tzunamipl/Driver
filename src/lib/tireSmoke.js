// Tyre-smoke particle effect: when a grounded wheel on a paved road
// surface (see lib/surfaceCompounds.js/lib/terrainSurface.js -
// wheel.surface is set every frame by app/mainLoop.js's classifySurfaceAt)
// is actually sliding (wheel.sliding, computed every physics step by
// wheeledVehicle.js's friction-circle solve in applyFriction() - the same
// flag hud/suspensionHud.js's red wheel fill reflects), puffs a few soft
// grey smoke particles from that wheel's contact point that drift upward,
// expand and fade like real tyre smoke. Deliberately simple - no real
// combustion/heat sim, just a pooled set of growing, fading spheres reused
// round-robin, matching lib/splash.js's own wheel-effect style (its doc
// comment covers the shared reasoning for this pattern).
//
// Gated on wheel.surface === 'road' specifically (not water/normal/open
// terrain) since real tyre smoke needs a hard, dry, grippy-enough surface
// to actually scorch against - a wheel spinning in mud or water sprays
// instead (see splash.js), it doesn't smoke.

import * as THREE from 'three';
import { isWheelGrounded } from './wheelContact.js';

// Pool sized generously above the worst-case concurrent-particle count
// (all wheels emitting at the fixed interval for a full particle lifetime)
// so a new puff never has to cut an older, still-visible one short.
const POOL_SIZE = 64;
const PARTICLES_PER_EMIT = 1;
const EMIT_INTERVAL_S = 0.07;
const PARTICLE_LIFETIME_S = 0.3;
// Puff grows over its life (real smoke expands/diffuses as it rises)
// rather than staying a fixed size like splash.js's splash droplets.
const START_SCALE = 0.12;
const END_SCALE = 0.55;
const BASE_OPACITY = 0.45;
// Slow upward drift (smoke is hot/light, not ballistic like a splash
// droplet) plus a little sideways jitter so a burst doesn't read as one
// perfectly uniform cloud. Velocity decays via DRAG so the puff drifts
// gently rather than coasting indefinitely.
const RISE_SPEED_MIN = 0.4;
const RISE_SPEED_MAX = 0.9;
const JITTER_SPEED = 0.35;
const DRAG = 0.98; // multiplies velocity each second (exponential decay) - also what gradually stops the inherited chassis velocity below
// Smoke is kicked up from a moving car's tyre, so it should carry some of
// the chassis's own momentum rather than spawning dead-still - only
// partially, so it still reads as smoke billowing from the contact patch
// rather than being dragged along rigidly.
const VELOCITY_INHERIT_FRACTION = 0.1;
// How much of a sliding wheel's own forward-axis spin-slip speed
// (wheeledVehicle.js's wheel.spinSlipSpeed - the contact patch's slip
// speed relative to the ground, from the tyre spinning faster/slower
// than the car is actually travelling) gets added straight to the
// puff's launch velocity, on top of the chassis-inherited velocity above
// - e.g. a wheel spinning up from a standing start throws smoke out
// behind the car instead of just drifting with it. Kept below 1 so this
// reads as "kicked by the tyre" rather than a literal 1:1 velocity match
// (customSlidingRotationalSpeed's free-spin speed can be quite large).
const SPIN_LAUNCH_FRACTION = 0.3;
// Clamp so an extreme free-spin speed can't fling a puff absurdly far.
const SPIN_LAUNCH_SPEED_MAX = 15;

const PARTICLE_GEO = new THREE.SphereGeometry(1, 6, 5);
// Slight grey variation per particle (set once at spawn, not animated) so
// a burst doesn't read as flat, identical clones.
const COLOR_MIN = 0x8a8a8a;
const COLOR_MAX = 0xc2c2c2;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Reused scratch object for the spin-slip velocity passed to spawnPuff
// each emit (avoids an allocation per puff/per wheel per frame).
const spinVelocityScratch = { x: 0, z: 0 };

/** Creates the tyre-smoke effect. Call update() once per rendered frame (see app/mainLoop.js). */
export function createTireSmoke(scene) {
  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    // One material per pooled particle (not shared) since each fades its
    // own opacity independently - small, fixed-size overhead (POOL_SIZE
    // instances allocated once up front), same tradeoff lib/jump.js makes
    // for its own per-particle state.
    const material = new THREE.MeshBasicMaterial({ color: COLOR_MIN, transparent: true, opacity: 0, depthWrite: false });
    const mesh = new THREE.Mesh(PARTICLE_GEO, material);
    mesh.visible = false;
    scene.add(mesh);
    pool.push({ mesh, material, velocity: new THREE.Vector3(), life: 0 });
  }
  let nextSlot = 0;
  // One re-arm timer per wheel, resized lazily the first time a vehicle
  // with a different wheel count is seen (mirrors splash.js/
  // suspensionHud.js's own lazy per-wheel-count rebuild).
  let wheelTimers = [];

  /**
   * @param {{x: number, y: number, z: number}} [chassisVelocity] - current chassis velocity (m/s), partially inherited so smoke drifts along with the car instead of spawning dead-still.
   * @param {{x: number, y: number, z: number}} [spinVelocity] - extra velocity (m/s) from the wheel's own forward-axis spin-slip (see wheeledVehicle.js's spinSlipSpeed), added on top so a wheel spinning faster than the car is moving actually launches smoke in that direction instead of just drifting with the chassis.
   */
  function spawnPuff(x, y, z, chassisVelocity, spinVelocity) {
    const p = pool[nextSlot];
    nextSlot = (nextSlot + 1) % POOL_SIZE;
    p.life = PARTICLE_LIFETIME_S;
    p.mesh.visible = true;
    p.mesh.scale.setScalar(START_SCALE);
    p.mesh.position.set(x, y, z);
    p.material.color.setHex(Math.random() < 0.5 ? COLOR_MIN : COLOR_MAX);
    p.material.opacity = BASE_OPACITY;
    const angle = Math.random() * Math.PI * 2;
    const jitter = Math.random() * JITTER_SPEED;
    p.velocity.set(Math.cos(angle) * jitter, RISE_SPEED_MIN + Math.random() * (RISE_SPEED_MAX - RISE_SPEED_MIN), Math.sin(angle) * jitter);
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
      p.mesh.scale.setScalar(START_SCALE + (END_SCALE - START_SCALE) * t);
      p.material.opacity = BASE_OPACITY * (1 - t);
    }

    if (!vehicle || !world) return;
    if (wheelTimers.length !== vehicle.wheelInfos.length) {
      wheelTimers = vehicle.wheelInfos.map(() => 0);
    }

    vehicle.wheelInfos.forEach((wheel, i) => {
      wheelTimers[i] -= dt;
      if (!wheel.sliding || wheel.surface !== 'road') return;
      if (wheelTimers[i] > 0) return;
      if (!isWheelGrounded(world, wheel)) return;

      const pos = wheel.worldTransform.position;
      // Spin-slip speed is signed along the wheel's own forward axis
      // (wheel.forwardWorld) - negative when the tyre is overspinning
      // forward faster than the car is moving (the common wheelspin
      // case), which throws smoke out behind the car rather than ahead
      // of it.
      const spinSpeed = clamp(wheel.spinSlipSpeed * SPIN_LAUNCH_FRACTION, -SPIN_LAUNCH_SPEED_MAX, SPIN_LAUNCH_SPEED_MAX);
      spinVelocityScratch.x = wheel.forwardWorld.x * spinSpeed;
      spinVelocityScratch.z = wheel.forwardWorld.z * spinSpeed;
      for (let n = 0; n < PARTICLES_PER_EMIT; n++) {
        spawnPuff(pos.x, pos.y - wheel.radius * 0.9, pos.z, vehicle.chassisBody.velocity, spinVelocityScratch);
      }
      wheelTimers[i] = EMIT_INTERVAL_S;
    });
  }

  return { update };
}
