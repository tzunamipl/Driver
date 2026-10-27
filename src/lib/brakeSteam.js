// Brake steam: small white puffs off the water around a wheel whose hot brake is wading
// (lib/brakes.js disc.steam), more and bigger the hotter it is.

import { createPuffPool } from './particles/puffPool.js';

const POOL_SIZE = 40;
const PARTICLE_LIFETIME_S = 1.1;
const START_SCALE = 0.06;
const END_SCALE = [0.2, 0.55];
const OPACITY = [0.2, 0.45];
const RISE_SPEED = [0.6, 1.4];
const OUTWARD_SPEED = [0.05, 0.3];
const DRAG = 0.4;
const VELOCITY_INHERIT_FRACTION = 0.5;
const COLORS = [0xf6f6f6, 0xdde1e4];
const PUFFS_PER_S = [2, 14];
// Puffs start this far inboard of the wheel centre (m, along the axle) and above the water line.
const INBOARD_M = 0.08;
const ABOVE_WATER_M = 0.05;

export function createBrakeSteam(scene) {
  const puffs = createPuffPool(scene, {
    size: POOL_SIZE,
    lifetime: PARTICLE_LIFETIME_S,
    startScale: START_SCALE,
    drag: DRAG,
    colors: COLORS,
  });

  function puff(wheel, velocity, intensity) {
    const p = wheel.worldTransform.position;
    const axle = wheel.axleWorld;
    const inboard = (wheel.chassisConnectionPointLocal.x > 0 ? 1 : -1) * INBOARD_M;
    const waterY = wheel.isInContact ? wheel.raycastResult.hitPointWorld.y : p.y - wheel.radius;
    puffs.spawn(p.x + axle.x * inboard + (Math.random() - 0.5) * 0.2, waterY + ABOVE_WATER_M, p.z + axle.z * inboard + (Math.random() - 0.5) * 0.2, {
      opacity: OPACITY[0] + (OPACITY[1] - OPACITY[0]) * intensity,
      endScale: (END_SCALE[0] + (END_SCALE[1] - END_SCALE[0]) * intensity) * (0.7 + Math.random() * 0.3),
      out: OUTWARD_SPEED,
      rise: RISE_SPEED,
      inherit: velocity,
      inheritFraction: VELOCITY_INHERIT_FRACTION,
    });
  }

  /** Per rendered frame; `vehicle` needs .brakes (else only the live puffs move on). */
  function update(dt, vehicle) {
    puffs.update(dt);
    const discs = vehicle?.brakes?.discs;
    if (!discs) return;
    discs.forEach((d, i) => {
      if (d.steam <= 0) return;
      const rate = PUFFS_PER_S[0] + (PUFFS_PER_S[1] - PUFFS_PER_S[0]) * d.steam;
      if (Math.random() < rate * dt) puff(vehicle.wheelInfos[i], vehicle.chassisBody.velocity, d.steam);
    });
  }

  return { update };
}
