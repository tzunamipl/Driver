// Terrain-dust particle effect: puffs of dry brown dust from a grounded
// wheel on plain/open ground (wheel.surface === 'normal' - see
// lib/surfaceCompounds.js/lib/terrainSurface.js's classifySurfaceAt, set
// every frame by app/mainLoop.js), from two independent triggers:
//
//  1. Sliding: when a wheel is actually sliding (wheel.sliding, computed
//     every physics step by wheeledVehicle.js's friction-circle solve -
//     the same flag hud/suspensionHud.js's red wheel fill reflects, and
//     lib/tireSmoke.js's own road-smoke trigger), kicks out a big puff of
//     dust regardless of overall speed - drifting/skidding throws up dirt
//     even at low speed.
//  2. Speed: once the chassis is moving faster than DUST_SPEED_KMH,
//     every grounded wheel on normal ground kicks up a smaller, steadier
//     trail puff (fewer particles, bigger gaps between puffs - especially
//     just above the threshold) that gets more frequent and more opaque
//     (less see-through) the faster the car goes, like a denser dust
//     trail being thrown up at speed. Both triggers share the same pool/
//     particle look and can fire together (e.g. drifting at speed).
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
// END_SCALE/COLOR_MIN/COLOR_MAX below) so the two read as distinct
// materials - dry dirt vs scorched rubber - rather than the same effect
// recoloured.

import * as THREE from 'three';
import { isWheelGrounded } from './wheelContact.js';

// Pool sized generously above the worst-case concurrent-particle count
// (all wheels emitting from both triggers at once, at their fixed
// intervals, for a full particle lifetime) so a new puff never has to cut
// an older, still-visible one short.
const POOL_SIZE = 128;
// A "big puff" per emit for the sliding trigger - noticeably more
// particles per burst than tireSmoke.js's 2, so this reads as a
// billowing cloud kicked out from behind the car rather than a thin
// wisp.
const SLIDE_PARTICLES_PER_EMIT = 5;
const SLIDE_EMIT_INTERVAL_S = 0.08;
const PARTICLE_LIFETIME_S = 0.9;
// Puff grows/drifts like tyre smoke and body-dust (real dust billows
// outward/up as it's kicked loose) rather than staying a fixed size like
// splash.js's ballistic droplets. Sized well above tireSmoke.js's
// START_SCALE/END_SCALE (0.12/0.55) so a dust puff visibly dwarfs a smoke
// puff even side by side.
const START_SCALE = 0.25;
const END_SCALE = 1.1;
const SLIDE_BASE_OPACITY = 0.5;
const RISE_SPEED_MIN = 0.2;
const RISE_SPEED_MAX = 0.7;
const OUTWARD_SPEED_MIN = 0.5;
const OUTWARD_SPEED_MAX = 1.8;
const DRAG = 0.88; // multiplies velocity each second (exponential decay)

// Speed trigger: below this chassis speed, no speed-based dust - only
// the sliding trigger above can still fire regardless of speed.
const DUST_SPEED_KMH = 50;
const DUST_SPEED_MS = DUST_SPEED_KMH / 3.6;
// Fewer particles per emit than the sliding trigger (this is a steady
// trail, not a skid cloud).
const SPEED_PARTICLES_PER_EMIT = 2;
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
    pool.push({ mesh, material, velocity: new THREE.Vector3(), life: 0, baseOpacity: SLIDE_BASE_OPACITY });
  }
  let nextSlot = 0;
  // One re-arm timer per wheel per trigger, resized lazily the first time
  // a vehicle with a different wheel count is seen (mirrors
  // lib/tireSmoke.js/lib/splash.js's own lazy per-wheel-count rebuild).
  // Kept separate so the sliding and speed triggers don't compete for the
  // same cooldown and can both fire independently (e.g. drifting fast).
  let slideTimers = [];
  let speedTimers = [];

  /** @param {number} baseOpacity - this particle's starting opacity, remembered so the fade-out below scales off it rather than a single shared constant. */
  function spawnPuff(x, y, z, baseOpacity) {
    const p = pool[nextSlot];
    nextSlot = (nextSlot + 1) % POOL_SIZE;
    p.life = PARTICLE_LIFETIME_S;
    p.baseOpacity = baseOpacity;
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
      p.material.opacity = p.baseOpacity * (1 - t);
    }

    if (!vehicle || !world) return;
    if (slideTimers.length !== vehicle.wheelInfos.length) {
      slideTimers = vehicle.wheelInfos.map(() => 0);
      speedTimers = vehicle.wheelInfos.map(() => 0);
    }

    const speed = vehicle.chassisBody.velocity.length();
    const speedDustActive = speed >= DUST_SPEED_MS;
    const speedFrac = Math.min(1, Math.max(0, (speed - DUST_SPEED_MS) / (SPEED_FOR_MIN_INTERVAL_MS - DUST_SPEED_MS)));
    const speedInterval = SPEED_EMIT_INTERVAL_MAX_S - (SPEED_EMIT_INTERVAL_MAX_S - SPEED_EMIT_INTERVAL_MIN_S) * speedFrac;
    const speedOpacity = SPEED_OPACITY_MIN + (SPEED_OPACITY_MAX - SPEED_OPACITY_MIN) * speedFrac;

    vehicle.wheelInfos.forEach((wheel, i) => {
      slideTimers[i] -= dt;
      speedTimers[i] -= dt;
      if (wheel.surface !== 'normal') return;
      if (!isWheelGrounded(world, wheel)) return;
      const pos = wheel.worldTransform.position;
      const groundY = pos.y - wheel.radius * 0.9;

      if (wheel.sliding && slideTimers[i] <= 0) {
        for (let n = 0; n < SLIDE_PARTICLES_PER_EMIT; n++) {
          spawnPuff(pos.x, groundY, pos.z, SLIDE_BASE_OPACITY);
        }
        slideTimers[i] = SLIDE_EMIT_INTERVAL_S;
      }

      if (speedDustActive && speedTimers[i] <= 0) {
        for (let n = 0; n < SPEED_PARTICLES_PER_EMIT; n++) {
          spawnPuff(pos.x, groundY, pos.z, speedOpacity);
        }
        speedTimers[i] = speedInterval;
      }
    });
  }

  return { update };
}
