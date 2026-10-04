// Simple wheel-splash particle effect: when a grounded wheel is over a
// water polygon (see waterAreas.js/vectorPolygonLayer.js's classifyAt,
// which streams regardless of the M-key debug overlay specifically so
// this can use it), bursts a few small bright-blue "ball" particles
// outward from that wheel's contact point, with basic gravity so they
// arc back down like a splash. Deliberately simple - no real fluid sim,
// just a pooled set of tiny spheres reused round-robin, matching the
// rest of this game's lightweight gameplay-effect modules (see jump.js/
// horn.js).

import * as THREE from 'three';
import { isWheelGrounded } from './wheelContact.js';

// Pool sized generously above the worst-case concurrent-particle count
// (all wheels splashing at min emit interval for a full particle
// lifetime) so a burst never has to cut an older, still-visible particle
// short to make room for a new one.
const POOL_SIZE = 96;
const PARTICLE_RADIUS = 0.07;
// Bright, fully-saturated blue, rendered unlit (MeshBasicMaterial) so it
// always reads as a vivid "splash" pop regardless of local lighting/
// shadow, rather than a subtler lit material like the other props here.
const PARTICLE_COLOR = 0x29d6ff;
const PARTICLES_PER_BURST = 3;
const PARTICLE_LIFETIME_S = 0.45;
const GRAVITY = 9.82;
// Below this chassis speed (m/s) the car is treated as just floating/
// parked in water rather than driving through it - no splash.
const MIN_SPLASH_SPEED = 0.6;
// Per-wheel re-arm cooldown, shortened at higher speed (more splashing
// the faster the wheel plows through water) down to a floor so the pool
// never has to serve more than POOL_SIZE concurrent particles.
const EMIT_INTERVAL_MAX_S = 0.14;
const EMIT_INTERVAL_MIN_S = 0.05;
const EMIT_SPEED_FOR_MIN_INTERVAL = 14; // m/s

const PARTICLE_GEO = new THREE.SphereGeometry(PARTICLE_RADIUS, 6, 5);
const PARTICLE_MAT = new THREE.MeshBasicMaterial({ color: PARTICLE_COLOR });

/** Creates the wheel-splash effect. Call update() once per rendered frame (see app/mainLoop.js). */
export function createSplash(scene) {
  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const mesh = new THREE.Mesh(PARTICLE_GEO, PARTICLE_MAT);
    mesh.visible = false;
    scene.add(mesh);
    pool.push({ mesh, velocity: new THREE.Vector3(), life: 0, groundY: 0 });
  }
  let nextSlot = 0;
  // One re-arm timer per wheel, resized lazily the first time a vehicle
  // with a different wheel count is seen (mirrors suspensionHud.js's own
  // lazy per-wheel-count rebuild).
  let wheelTimers = [];

  function spawnBurst(x, y, z, speed) {
    for (let n = 0; n < PARTICLES_PER_BURST; n++) {
      const p = pool[nextSlot];
      nextSlot = (nextSlot + 1) % POOL_SIZE;
      p.life = PARTICLE_LIFETIME_S;
      p.mesh.visible = true;
      p.mesh.scale.setScalar(1);
      p.mesh.position.set(x, y, z);
      // Recorded per-particle (rather than a fixed world height) since the
      // tire's contact point itself sits at whatever the local terrain/
      // water elevation is - see terrain.js's heightOffset doc comment
      // on why that's not reliably near world y=0.
      p.groundY = y;
      const angle = Math.random() * Math.PI * 2;
      const outSpeed = 1.2 + Math.random() * 1.6 + Math.min(speed, EMIT_SPEED_FOR_MIN_INTERVAL) * 0.1;
      p.velocity.set(Math.cos(angle) * outSpeed, 2.2 + Math.random() * 1.8, Math.sin(angle) * outSpeed);
    }
  }

  /**
   * @param {number} dt - frame delta in seconds.
   * @param {object|null} vehicle - the active RaycastVehicle-like object (see wheeledVehicle.js), or null if no car is active yet.
   * @param {import('cannon-es').World} world
   * @param {{ classifyAt(x: number, z: number): string|null }|null} waterAreas
   */
  function update(dt, vehicle, world, waterAreas) {
    // Age/move every live particle regardless of whether a vehicle/water
    // check even runs this frame, so already-spawned splashes keep
    // animating smoothly.
    for (const p of pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.visible = false;
        continue;
      }
      p.velocity.y -= GRAVITY * dt;
      p.mesh.position.addScaledVector(p.velocity, dt);
      // Simple clamp instead of real buoyancy/surface tracking - keeps a
      // particle from visibly diving below the point it was emitted from
      // (the tire's contact height) once it arcs back down.
      if (p.mesh.position.y < p.groundY) {
        p.mesh.position.y = p.groundY;
        p.velocity.y = 0;
      }
      p.mesh.scale.setScalar(Math.max(0.05, p.life / PARTICLE_LIFETIME_S));
    }

    if (!vehicle || !world || !waterAreas) return;
    if (wheelTimers.length !== vehicle.wheelInfos.length) {
      wheelTimers = vehicle.wheelInfos.map(() => 0);
    }

    const speed = vehicle.chassisBody.velocity.length();
    if (speed < MIN_SPLASH_SPEED) return;

    vehicle.wheelInfos.forEach((wheel, i) => {
      wheelTimers[i] -= dt;
      if (wheelTimers[i] > 0) return;
      if (!isWheelGrounded(world, wheel)) return;
      const pos = wheel.worldTransform.position;
      if (waterAreas.classifyAt(pos.x, pos.z) !== 'water') return;

      spawnBurst(pos.x, pos.y - wheel.radius, pos.z, speed);
      const speedFrac = Math.min(1, speed / EMIT_SPEED_FOR_MIN_INTERVAL);
      wheelTimers[i] = EMIT_INTERVAL_MAX_S - (EMIT_INTERVAL_MAX_S - EMIT_INTERVAL_MIN_S) * speedFrac;
    });
  }

  return { update };
}
