// Wheel splash: grounded wheels over water (waterAreas polygons or narrow
// rivers centerlines) burst small blue balls that arc down under gravity.

import * as THREE from 'three';
import { isWheelGrounded } from './wheelContact.js';

// Sized so a burst never cuts a visible particle short.
const POOL_SIZE = 96;
const PARTICLE_RADIUS = 0.07;
// Unlit, so it always pops regardless of lighting.
const PARTICLE_COLOR = 0x29d6ff;
const PARTICLES_PER_BURST = 3;
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

/** Creates the wheel-splash effect. Call update() once per frame. */
export function createSplash(scene) {
  // Audio
  const audioCtx = new AudioContext();
  let lastWaterSound = 0;

  const noiseBuffer = audioCtx.createBuffer(
      1, audioCtx.sampleRate, audioCtx.sampleRate
  );
  const data = noiseBuffer.getChannelData(0);

  for (let i = 0; i < data.length; i++) {
    data[i] = Math.random() * 2 - 1;
  }

  function playWaterSound(volume = 4) {
    const source = audioCtx.createBufferSource();
    const filter = audioCtx.createBiquadFilter();
    const gain = audioCtx.createGain();
    const now = audioCtx.currentTime;
    if (now - lastWaterSound < 0.2) return;
    lastWaterSound = now;

    source.buffer = noiseBuffer;
    filter.type = 'lowpass';
    filter.frequency.value = 600 + Math.random() * 200;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 2);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 5);

    source.start(now);
    source.stop(now + 0.65);
  }

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

  function spawnBurst(x, y, z, speed) {
    for (let n = 0; n < PARTICLES_PER_BURST; n++) {
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

    if (!vehicle || !world || (!waterAreas && !rivers)) return;
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
      if (streets?.containsPoint(pos.x, pos.z)) return;
      const onWater = waterAreas?.classifyAt(pos.x, pos.z) === 'water' || rivers?.containsPoint(pos.x, pos.z);
      if (!onWater) return;

      spawnBurst(pos.x, pos.y - wheel.radius, pos.z, speed);
      playWaterSound(Math.min(0.2, speed * 0.04));
      const speedFrac = Math.min(1, speed / EMIT_SPEED_FOR_MIN_INTERVAL);
      wheelTimers[i] = EMIT_INTERVAL_MAX_S - (EMIT_INTERVAL_MAX_S - EMIT_INTERVAL_MIN_S) * speedFrac;
    });
  }

  return { update };
}
