// Wheel splash: grounded wheels over water (waterAreas polygons or narrow
// rivers centerlines) burst small blue balls that arc down under gravity.

import * as THREE from 'three';
import { isWheelGrounded, wheelSide } from './wheelContact.js';
import { keepParticle } from './particles/particleDetail.js';

// Sized so a burst never cuts a visible particle short.
const POOL_SIZE = 160;
const PARTICLE_RADIUS = 0.07;
// Unlit, so it always pops regardless of lighting.
const PARTICLE_COLOR = 0x29d6ff;
const PARTICLES_PER_BURST = 3;
// Wading deeper (vehicle.wheelSinks, m) throws more water per burst.
const EXTRA_PARTICLES_PER_SINK_M = 3;
const PARTICLE_LIFETIME_S = 0.45;
const GRAVITY = 9.82;
// Below this speed (m/s) the car is just floating: no splash.
const MIN_SPLASH_SPEED = 0.6;
// Per-wheel cooldown, shorter at speed, with a floor.
const EMIT_INTERVAL_MAX_S = 0.14;
const EMIT_INTERVAL_MIN_S = 0.05;
const EMIT_SPEED_FOR_MIN_INTERVAL = 1; // m/s

const PARTICLE_GEO = new THREE.SphereGeometry(PARTICLE_RADIUS, 6, 5);
const PARTICLE_MAT = new THREE.MeshBasicMaterial({ color: PARTICLE_COLOR });

/**
 * Creates the wheel-splash effect. Call update() once per frame.
 * `onWade(wetFraction, speed, side)` fires every frame with the share of wheels in water and their side (-1 left .. 1 right).
 */
export function createSplash(scene, { onWade } = {}) {
  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const mesh = new THREE.Mesh(PARTICLE_GEO, PARTICLE_MAT);
    mesh.visible = false;
    scene.add(mesh);
    pool.push({ mesh, velocity: new THREE.Vector3(), life: 0, groundY: 0 });
  }
  let nextSlot = 0;
  // Per-wheel timers, resized when the wheel count changes.
  let wheelTimers = [];

  function spawnBurst(x, y, z, speed, count) {
    for (let n = 0; n < count; n++) {
      if (!keepParticle()) continue;
      const p = pool[nextSlot];
      nextSlot = (nextSlot + 1) % POOL_SIZE;
      p.life = PARTICLE_LIFETIME_S;
      p.mesh.visible = true;
      p.mesh.scale.setScalar(1);
      p.mesh.position.set(x, y, z);
      // Emission height, to stop particles falling below it.
      p.groundY = y;
      const angle = Math.random() * Math.PI * 2;
      const outSpeed = 1.2 + Math.random() * 1.6 + Math.min(speed, EMIT_SPEED_FOR_MIN_INTERVAL) * 0.1;
      p.velocity.set(Math.cos(angle) * outSpeed, 2.2 + Math.random() * 1.8, Math.sin(angle) * outSpeed);
    }
  }

  /**
   * @param {number} dt - frame delta in seconds.
   * @param {object|null} vehicle - wheeledVehicle.js vehicle, or null.
   * @param {import('cannon-es').World} world
   * @param {{ classifyAt(x: number, z: number): string|null }|null} waterAreas
   * @param {{ containsPoint(x: number, z: number): boolean }|null} [streets] - road wins over water (bridges).
   * @param {{ containsPoint(x: number, z: number): boolean }|null} [rivers] - narrow waterways count as water.
   */
  function update(dt, vehicle, world, waterAreas, streets, rivers) {
    for (const p of pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.visible = false;
        continue;
      }
      p.velocity.y -= GRAVITY * dt;
      p.mesh.position.addScaledVector(p.velocity, dt);
        // Clamp instead of buoyancy: don't fall below the emission point.
      if (p.mesh.position.y < p.groundY) {
        p.mesh.position.y = p.groundY;
        p.velocity.y = 0;
      }
      p.mesh.scale.setScalar(Math.max(0.05, p.life / PARTICLE_LIFETIME_S));
    }

    if (!vehicle || !world || (!waterAreas && !rivers)) {
      onWade?.(0, 0);
      return;
    }
    if (wheelTimers.length !== vehicle.wheelInfos.length) {
      wheelTimers = vehicle.wheelInfos.map(() => 0);
    }

    const speed = vehicle.chassisBody.velocity.length();
    let wetWheels = 0;
    let wetSide = 0;
    vehicle.wheelInfos.forEach((wheel, i) => {
      wheelTimers[i] -= dt;
      if (!isWheelGrounded(world, wheel)) return;
      const pos = wheel.worldTransform.position;
      if (streets?.containsPoint(pos.x, pos.z)) return;
      const onWater = waterAreas?.classifyAt(pos.x, pos.z) === 'water' || rivers?.containsPoint(pos.x, pos.z);
      if (!onWater) return;
      wetWheels++;
      wetSide += wheelSide(wheel);

      if (speed < MIN_SPLASH_SPEED || wheelTimers[i] > 0) return;
      // Ground contact = water surface (the visible wheel may be sunk below it).
      const surfaceY = wheel.isInContact ? wheel.raycastResult.hitPointWorld.y : pos.y - wheel.radius;
      const count = PARTICLES_PER_BURST + Math.round((vehicle.wheelSinks?.[i] ?? 0) * EXTRA_PARTICLES_PER_SINK_M);
      spawnBurst(pos.x, surfaceY, pos.z, speed, count);
      const speedFrac = Math.min(1, speed / EMIT_SPEED_FOR_MIN_INTERVAL);
      wheelTimers[i] = EMIT_INTERVAL_MAX_S - (EMIT_INTERVAL_MAX_S - EMIT_INTERVAL_MIN_S) * speedFrac;
    });
    onWade?.(vehicle.wheelInfos.length ? wetWheels / vehicle.wheelInfos.length : 0, speed, wetWheels ? wetSide / wetWheels : 0);
  }

  return { update };
}
