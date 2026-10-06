// Body-dust particle effect: when the chassis itself (not a wheel - see
// splash.js/tireSmoke.js for those) hits the ground, e.g. a hard jump
// landing nose/belly-first, a rollover scrape, or a building hit that
// pancakes the car onto the terrain, puffs a single big dusty tan/brown
// particle out from the chassis' own center - deliberately not the
// contact's corner point (which lands right around where the wheels
// sit), so the puff reads as coming from the body. Fed by
// app/carManager.js's chassisBody 'collide' listener (fired by cannon-es
// every physics step a contact is active - see cannon-es's
// Body.COLLIDE_EVENT_NAME doc comment), filtered there to the ground
// collision group, rather than by polling clearance every frame like
// scoring.js's airtime check - a direct contact is the actual "body
// touched the ground" signal, not an inferred one. Deliberately simple -
// no real dirt/soil sim, just a pooled set of growing, fading spheres
// reused round-robin, matching splash.js/tireSmoke.js's own shared
// wheel-effect pattern (their doc comments cover the shared reasoning).

import * as THREE from 'three';

// Pool sized generously above the worst-case concurrent-particle count
// (every contact point emitting at the re-arm cooldown for a full
// particle lifetime) so a burst never has to cut an older, still-visible
// particle short to make room for a new one.
const POOL_SIZE = 16;
const PARTICLE_LIFETIME_S = 0.6;
// Puff grows and drifts like tyre smoke (real dust billows outward/up as
// it's kicked loose) rather than staying a fixed size like splash.js's
// ballistic droplets.
const START_SCALE = 0.4;
// Single big puff per impact (scaled further by impact speed below), not
// a spray of several small ones.
const END_SCALE_MIN = 1.1;
const END_SCALE_MAX = 2.4;
const BASE_OPACITY = 0.55;
const RISE_SPEED_MIN = 0.3;
const RISE_SPEED_MAX = 1.1;
const OUTWARD_SPEED_MIN = 0.2;
const OUTWARD_SPEED_MAX = 0.6;
const DRAG = 0.85; // multiplies velocity each second (exponential decay) - also what gradually stops the inherited chassis velocity below
// Dust kicked off the chassis should carry some of the car's own momentum
// at the moment of impact rather than spawning dead-still - only
// partially, so a hard belly-flop still reads as an outward-flung dust
// cloud rather than a block of dust gliding off with the car.
const VELOCITY_INHERIT_FRACTION = 0.4;
// Below this impact speed (m/s, along the contact normal) a contact reads
// as a gentle rest/settle rather than an actual "hit" - no dust.
const MIN_IMPACT_SPEED = 2.5;
// Harder impacts kick up more dust, scaled up to this speed.
const IMPACT_SPEED_FOR_MAX_BURST = 10;
// Per-contact-point re-arm cooldown so a chassis dragging/scraping along
// the ground continuously doesn't spawn a new burst every single physics
// step.
const EMIT_INTERVAL_S = 0.1;
// Small random offset so repeated puffs from the same spot (e.g. a car
// dragging/scraping in place) don't all spawn from the exact same point.
const POSITION_JITTER = 0.15;

const PARTICLE_GEO = new THREE.SphereGeometry(1, 6, 5);
// Dusty tan/brown variation per particle (set once at spawn, not
// animated) so a burst doesn't read as flat, identical clones.
const COLOR_MIN = 0x8a7352;
const COLOR_MAX = 0xc2a775;

/** Creates the chassis body-dust effect. Call update() once per rendered frame (see app/mainLoop.js). */
export function createBodyDust(scene) {
  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    // One material per pooled particle (not shared), same tradeoff
    // tireSmoke.js makes for its own per-particle state.
    const material = new THREE.MeshBasicMaterial({ color: COLOR_MIN, transparent: true, opacity: 0, depthWrite: false });
    const mesh = new THREE.Mesh(PARTICLE_GEO, material);
    mesh.visible = false;
    scene.add(mesh);
    pool.push({ mesh, material, velocity: new THREE.Vector3(), life: 0, endScale: END_SCALE_MIN });
  }
  let nextSlot = 0;
  let rearmTimer = 0;

  /** @param {{x: number, y: number, z: number}} [chassisVelocity] - chassis velocity (m/s) at the moment of impact, partially inherited so the dust is flung along with the car's motion rather than spawning dead-still. */
  function spawnPuff(x, y, z, endScale, chassisVelocity) {
    const p = pool[nextSlot];
    nextSlot = (nextSlot + 1) % POOL_SIZE;
    p.life = PARTICLE_LIFETIME_S;
    p.endScale = endScale;
    p.mesh.visible = true;
    p.mesh.scale.setScalar(START_SCALE);
    p.mesh.position.set(
      x + (Math.random() - 0.5) * POSITION_JITTER,
      y + (Math.random() - 0.5) * POSITION_JITTER,
      z + (Math.random() - 0.5) * POSITION_JITTER
    );
    p.material.color.setHex(Math.random() < 0.5 ? COLOR_MIN : COLOR_MAX);
    p.material.opacity = BASE_OPACITY;
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
  }

  /**
   * Called from the chassis' 'collide' listener (see
   * app/carManager.js) whenever a contact against the ground collision
   * group is reported this step.
   * @param {{x: number, y: number, z: number}} point - world-space spawn point, the chassis' own center (not a wheel/corner contact point).
   * @param {number} impactSpeed - impact speed along the contact normal (m/s).
   * @param {{x: number, y: number, z: number}} [chassisVelocity] - chassis velocity at the moment of impact, partially inherited by the spawned dust.
   */
  function onGroundContact(point, impactSpeed, chassisVelocity) {
    if (impactSpeed < MIN_IMPACT_SPEED) return;
    if (rearmTimer > 0) return;
    // One single puff per impact (harder hits just grow it bigger), not a
    // spray of several small ones.
    const speedFrac = Math.min(1, (impactSpeed - MIN_IMPACT_SPEED) / (IMPACT_SPEED_FOR_MAX_BURST - MIN_IMPACT_SPEED));
    const endScale = END_SCALE_MIN + (END_SCALE_MAX - END_SCALE_MIN) * speedFrac;
    spawnPuff(point.x, point.y, point.z, endScale, chassisVelocity);
    rearmTimer = EMIT_INTERVAL_S;
  }

  /** @param {number} dt - frame delta in seconds. */
  function update(dt) {
    rearmTimer -= dt;
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
      p.material.opacity = BASE_OPACITY * (1 - t);
    }
  }

  return { update, onGroundContact };
}
