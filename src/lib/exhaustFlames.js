// Exhaust backfire: flame pops from the tailpipes while revving high off load
// (lift-off, gear-change torque cut). Amount from descriptor `backfire` (0 none .. 1 full).
// Tips come from descriptor `exhaustTips` ([{ pos: [x, y, z], dir: [x, y, z] }],
// chassis-local); without them, one tip at the rear bottom of the body.

import * as THREE from 'three';
import { createPuffPool } from './particles/puffPool.js';

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

const tipScratch = new THREE.Vector3();
const dirScratch = new THREE.Vector3();

/** Bounds of every mesh under `root` in root's own frame. */
function localBounds(root) {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const toLocal = new THREE.Matrix4();
  const part = new THREE.Box3();
  const box = new THREE.Box3();
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    box.union(part.copy(o.geometry.boundingBox).applyMatrix4(toLocal.multiplyMatrices(inverse, o.matrixWorld)));
  });
  return box;
}

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
    return tips;
  }

  function pop(chassisMesh, velocity, strength) {
    onPop?.(strength);
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
