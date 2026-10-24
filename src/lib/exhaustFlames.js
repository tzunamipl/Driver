// Exhaust backfire: flame pops from the tailpipes while revving high off load
// (lift-off, gear-change torque cut). Amount from descriptor `backfire` (0 none .. 1 full).
// Tips come from descriptor `exhaustTips` ([{ pos: [x, y, z], dir: [x, y, z] }],
// chassis-local); without them, one tip at the rear bottom of the body.
// Each pop flashes one orange point light at the tips' midpoint.

import * as THREE from 'three';
import { createPuffPool } from './particles/puffPool.js';
import { localBounds } from './vehicleShared.js';

const DEFAULT_BACKFIRE = 0;
const POOL_SIZE = 96;
const PARTICLE_LIFETIME_S = 0.12;
const START_SCALE = 0.07;
const END_SCALE = [0.16, 0.3]; // along the tongue: base -> tip
const PUFFS_PER_POP = 4;
const TONGUE_LENGTH = 0.35; // m, puffs spread from the tip along the pipe direction
const FLAME_SPEED = 5; // m/s along the pipe direction, on top of the car's velocity
const JITTER_SPEED = [0, 0.4];
const DRAG = 0.05;
const OPACITY = 0.9;
const COLORS = [0xff6a10, 0xffb030];
// Off-load rpm (fraction of idle..redline) where pops start; rate climbs to the max at redline.
const MIN_REV_FRACTION = 0.55;
const POP_RATE_PER_S = [3, 12];
const OVERRUN_STRENGTH = [0.5, 0.85]; // sound strength of off-load pops, gear-change pops are 1
const DEFAULT_DIR = [0, 0, -1];
const LIGHT_COLOR = 0xff7a20;
const LIGHT_INTENSITY = 60; // cd at a strength-1 pop
const LIGHT_DISTANCE_M = 8;
const LIGHT_DECAY = 2;
const LIGHT_FADE_S = 0.05; // time constant of the flash dying away
const LIGHT_FLICKER = 0.35; // random +/- share per frame

const tipScratch = new THREE.Vector3();
const dirScratch = new THREE.Vector3();

/**
 * Creates the exhaust-flame effect. Call update() once per rendered frame.
 * onPop(strength 0..1) fires once per pop, for the sound.
 */
export function createExhaustFlames(scene, { onPop } = {}) {
  const puffs = createPuffPool(scene, {
    size: POOL_SIZE,
    lifetime: PARTICLE_LIFETIME_S,
    startScale: START_SCALE,
    drag: DRAG,
    colors: COLORS,
    glow: true,
  });
  let tipsFor = null; // descriptor the cached tips belong to
  let tips = [];
  let prevShiftTimer = 0;
  let prevRevFraction = 0;
  // Always in the scene at intensity 0: adding/removing lights recompiles every lit shader.
  const light = new THREE.PointLight(LIGHT_COLOR, 0, LIGHT_DISTANCE_M, LIGHT_DECAY);
  light.castShadow = false;
  scene.add(light);
  const lightLocal = new THREE.Vector3(); // tips' midpoint, a bit out along the flame
  let flash = 0;

  function resolveTips(descriptor, chassisMesh) {
    if (tipsFor === descriptor) return tips;
    tipsFor = descriptor;
    if (descriptor.exhaustTips) {
      tips = descriptor.exhaustTips.map(({ pos, dir = DEFAULT_DIR }) => ({
        pos: new THREE.Vector3(...pos),
        dir: new THREE.Vector3(...dir).normalize(),
      }));
    } else {
      const box = localBounds(chassisMesh);
      tips = [{ pos: new THREE.Vector3(box.min.x * 0.55, box.min.y + 0.15, box.min.z), dir: new THREE.Vector3(...DEFAULT_DIR) }];
    }
    lightLocal.set(0, 0, 0);
    for (const tip of tips) lightLocal.addScaledVector(tip.pos, 1 / tips.length).addScaledVector(tip.dir, TONGUE_LENGTH / 2 / tips.length);
    return tips;
  }

  function updateLight(dt, chassisMesh) {
    flash *= Math.exp(-dt / LIGHT_FADE_S);
    if (flash < 0.01 || !chassisMesh) {
      flash = 0;
      light.intensity = 0;
      return;
    }
    light.position.copy(lightLocal).applyQuaternion(chassisMesh.quaternion).add(chassisMesh.position);
    light.intensity = LIGHT_INTENSITY * flash * (1 + (Math.random() - 0.5) * 2 * LIGHT_FLICKER);
  }

  function pop(chassisMesh, velocity, strength) {
    onPop?.(strength);
    flash = Math.max(flash, strength);
    for (const tip of tips) {
      tipScratch.copy(tip.pos).applyQuaternion(chassisMesh.quaternion).add(chassisMesh.position);
      dirScratch.copy(tip.dir).applyQuaternion(chassisMesh.quaternion);
      for (let n = 0; n < PUFFS_PER_POP; n++) {
        const t = n / (PUFFS_PER_POP - 1);
        const along = t * TONGUE_LENGTH * (0.6 + Math.random() * 0.6);
        const vy = velocity.y + dirScratch.y * FLAME_SPEED;
        puffs.spawn(tipScratch.x + dirScratch.x * along, tipScratch.y + dirScratch.y * along, tipScratch.z + dirScratch.z * along, {
          opacity: OPACITY,
          endScale: END_SCALE[0] + (END_SCALE[1] - END_SCALE[0]) * t,
          out: JITTER_SPEED,
          rise: [vy, vy],
          inherit: velocity,
          inheritFraction: 1,
          extra: { x: dirScratch.x * FLAME_SPEED, z: dirScratch.z * FLAME_SPEED },
        });
      }
    }
  }

  /**
   * @param {number} dt - frame delta in seconds.
   * @param {object|null} vehicle - wheeledVehicle.js vehicle (needs .engine), or null.
   * @param {THREE.Object3D|null} chassisMesh
   * @param {object} descriptor - vehicle descriptor.
   */
  function update(dt, vehicle, chassisMesh, descriptor) {
    puffs.update(dt);
    updateLight(dt, chassisMesh);

    const engine = vehicle?.engine;
    if (!engine || !chassisMesh || !descriptor) return;
    const backfire = descriptor.backfire ?? DEFAULT_BACKFIRE;
    if (backfire <= 0) return;

    const revFraction = (engine.rpm - engine.idleRpm) / (engine.redlineRpm - engine.idleRpm);
    const shiftStarted = engine.shiftTimer > prevShiftTimer;
    const shiftRevFraction = Math.max(revFraction, prevRevFraction); // upshift drops rpm the same frame
    prevShiftTimer = engine.shiftTimer;
    prevRevFraction = revFraction;

    resolveTips(descriptor, chassisMesh);
    if (shiftStarted && shiftRevFraction > MIN_REV_FRACTION && Math.random() < backfire) {
      pop(chassisMesh, vehicle.chassisBody.velocity, 1);
      return;
    }
    const offLoad = engine.throttle === 0 || engine.shiftTimer > 0;
    if (!offLoad || revFraction <= MIN_REV_FRACTION) return;
    const k = Math.min(1, (revFraction - MIN_REV_FRACTION) / (1 - MIN_REV_FRACTION));
    const rate = (POP_RATE_PER_S[0] + (POP_RATE_PER_S[1] - POP_RATE_PER_S[0]) * k) * backfire;
    if (Math.random() < rate * dt) pop(chassisMesh, vehicle.chassisBody.velocity, OVERRUN_STRENGTH[0] + (OVERRUN_STRENGTH[1] - OVERRUN_STRENGTH[0]) * k);
  }

  return { update };
}
