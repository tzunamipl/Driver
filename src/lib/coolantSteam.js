// Coolant steam: white puffs popping from under the bonnet's front edge while
// coolant escapes (radiator leak or boil-over), more often and bigger with the
// loss rate. onLeak(intensity 0..1) fires every frame, for the hiss.

import * as THREE from 'three';
import { createPuffPool } from './particles/puffPool.js';
import { localBounds } from './vehicleShared.js';

const POOL_SIZE = 48;
const PARTICLE_LIFETIME_S = 2.4;
const START_SCALE = 0.1;
const END_SCALE = [0.35, 0.9]; // trickle .. full leak
const OPACITY = [0.25, 0.5];
const RISE_SPEED = [0.15, 0.35];
const OUTWARD_SPEED = [0.1, 0.4];
const DRAG = 0.35;
// Steady lift: settles at ~0.4 m/s up against the drag, so the steam drifts slowly upward.
const BUOYANCY = 0.45;
const VELOCITY_INHERIT_FRACTION = 0.7;
const COLORS = [0xf4f4f4, 0xd8dcdf];
// Loss rate (L/s) treated as the full effect: an open radiator at full pressure.
const FULL_LOSS_LPS = 0.08;
const POPS_PER_S = [0.2, 1.5];
const PUFFS_PER_POP = [1, 3];
// Emitter in the body's bounds: share of half-width spread, height share, inset from the nose (m).
const SPREAD_X = 0.5;
const HEIGHT_SHARE = 0.55;
const NOSE_INSET_M = 0.25;

const pointScratch = new THREE.Vector3();

/** Creates the steam effect. Call update() once per rendered frame. */
export function createCoolantSteam(scene, { onLeak } = {}) {
  const puffs = createPuffPool(scene, {
    size: POOL_SIZE,
    lifetime: PARTICLE_LIFETIME_S,
    startScale: START_SCALE,
    drag: DRAG,
    buoyancy: BUOYANCY,
    colors: COLORS,
  });
  let boundsFor = null; // chassis mesh the cached bounds belong to
  const box = new THREE.Box3();

  function emitterBox(chassisMesh) {
    if (boundsFor !== chassisMesh) {
      boundsFor = chassisMesh;
      box.copy(localBounds(chassisMesh));
    }
    return box;
  }

  function pop(chassisMesh, velocity, intensity) {
    const b = emitterBox(chassisMesh);
    const halfWidth = (b.max.x - b.min.x) / 2;
    const count = PUFFS_PER_POP[0] + Math.round(Math.random() * (PUFFS_PER_POP[1] - PUFFS_PER_POP[0]) * intensity);
    for (let n = 0; n < count; n++) {
      pointScratch
        .set(
          (b.max.x + b.min.x) / 2 + (Math.random() * 2 - 1) * halfWidth * SPREAD_X,
          b.min.y + (b.max.y - b.min.y) * HEIGHT_SHARE,
          b.max.z - NOSE_INSET_M * Math.random()
        )
        .applyQuaternion(chassisMesh.quaternion)
        .add(chassisMesh.position);
      const size = 0.6 + Math.random() * 0.4;
      puffs.spawn(pointScratch.x, pointScratch.y, pointScratch.z, {
        opacity: OPACITY[0] + (OPACITY[1] - OPACITY[0]) * intensity,
        endScale: (END_SCALE[0] + (END_SCALE[1] - END_SCALE[0]) * intensity) * size,
        out: OUTWARD_SPEED,
        rise: RISE_SPEED,
        inherit: velocity,
        inheritFraction: VELOCITY_INHERIT_FRACTION,
      });
    }
  }

  /**
   * @param {number} dt - frame delta in seconds.
   * @param {object|null} vehicle - wheeled vehicle (needs .heat), or null.
   * @param {THREE.Object3D|null} chassisMesh
   */
  function update(dt, vehicle, chassisMesh) {
    puffs.update(dt);
    const loss = vehicle?.heat && chassisMesh ? vehicle.heat.lossLps : 0;
    // sqrt: a slow seep should still show and be heard.
    const intensity = Math.sqrt(Math.min(1, loss / FULL_LOSS_LPS));
    onLeak?.(intensity);
    if (intensity <= 0) return;
    const rate = POPS_PER_S[0] + (POPS_PER_S[1] - POPS_PER_S[0]) * intensity;
    if (Math.random() < rate * dt) pop(chassisMesh, vehicle.chassisBody.velocity, intensity);
  }

  return { update };
}
