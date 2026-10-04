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
const PARTICLES_PER_EMIT = 2;
const EMIT_INTERVAL_S = 0.06;
const PARTICLE_LIFETIME_S = 0.7;
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
const DRAG = 0.9; // multiplies velocity each second (exponential decay)

const PARTICLE_GEO = new THREE.SphereGeometry(1, 6, 5);
// Slight grey variation per particle (set once at spawn, not animated) so
// a burst doesn't read as flat, identical clones.
const COLOR_MIN = 0x8a8a8a;
const COLOR_MAX = 0xc2c2c2;

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

  function spawnPuff(x, y, z) {
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
      for (let n = 0; n < PARTICLES_PER_EMIT; n++) {
        spawnPuff(pos.x, pos.y - wheel.radius * 0.9, pos.z);
      }
      wheelTimers[i] = EMIT_INTERVAL_S;
    });
  }

  return { update };
}
