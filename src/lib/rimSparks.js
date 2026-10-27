// Flat tyres: a smoke puff + spark burst when a tyre pops, then sparks from
// every rim running on a hard surface, more with rubbing speed. Visual only;
// the grinding sound goes out via onGrind.

import { isWheelGrounded, wheelSide } from './wheelContact.js';
import { createPuffPool } from './particles/puffPool.js';
import { createSparkles } from './particles/sparkles.js';

const HARD_SURFACES = new Set(['road', 'cobblestone', 'rock']);
const MIN_RUB_SPEED = 1.5; // m/s
const SPARKS_PER_M = 7; // per metre the rim rubs along the ground
const MAX_SPARKS_PER_S = 260; // per wheel
const RIM_SPARK = { speed: [1.5, 5], up: [0.15, 0.6], life: [0.15, 0.45], size: 0.5, spread: 0.15 };
const RIM_INHERIT_FRACTION = 0.15; // contact patch barely moves; the sparks trail behind the car

const POP_SPARKS = { count: 36, speed: [2, 7], up: [0.2, 0.8], life: [0.2, 0.6], size: 0.6, spread: 0.2 };
const POP_PUFFS = 10;
const POP_PUFF = { opacity: 0.55, endScale: [0.7, 1.2], out: [0.6, 2], rise: [0.3, 1.2] };
const POP_INHERIT_FRACTION = 0.6;

const inheritScratch = { x: 0, y: 0, z: 0 };

/** Speed the rim's contact point rubs along the ground (m/s): rolling plus any slide. */
function rubSpeed(wheel) {
  return Math.abs(wheel.spinSpeed) + Math.hypot(wheel.spinSlipSpeed, wheel.sideSlipSpeed);
}

/**
 * onGrind(dt, speed, side) fires once per update with the fastest sparking rim's rub speed (0 = none) and its side (-1 left .. 1 right), for the sound.
 */
export function createRimSparks(scene, { onGrind } = {}) {
  const sparkles = createSparkles(scene);
  const puffs = createPuffPool(scene, {
    size: 32,
    lifetime: 0.9,
    startScale: 0.2,
    drag: 0.2,
    colors: [0xb8b8b8, 0xdedede],
  });
  let owed = new Map(); // wheel -> fractional sparks carried to the next frame

  function inherit(velocity, fraction) {
    inheritScratch.x = velocity.x * fraction;
    inheritScratch.y = velocity.y * fraction;
    inheritScratch.z = velocity.z * fraction;
    return inheritScratch;
  }

  /** The bang: a puff of the tyre's air and rubber + a shower of sparks from the rim hitting the ground. */
  function burst(wheel, velocity) {
    const pos = wheel.worldTransform.position;
    const groundY = pos.y - wheel.radius;
    for (let i = 0; i < POP_PUFFS; i++) {
      puffs.spawn(pos.x, groundY + wheel.radius * 0.5 * Math.random(), pos.z, {
        opacity: POP_PUFF.opacity,
        endScale: POP_PUFF.endScale[0] + Math.random() * (POP_PUFF.endScale[1] - POP_PUFF.endScale[0]),
        out: POP_PUFF.out,
        rise: POP_PUFF.rise,
        inherit: velocity,
        inheritFraction: POP_INHERIT_FRACTION,
      });
    }
    sparkles.throw(pos.x, groundY, pos.z, { ...POP_SPARKS, inherit: inherit(velocity, RIM_INHERIT_FRACTION) });
  }

  /**
   * @param {number} dt - frame delta in seconds.
   * @param {object|null} vehicle - wheeledVehicle.js vehicle, or null.
   * @param {import('cannon-es').World|null} world
   */
  function update(dt, vehicle, world) {
    puffs.update(dt);
    sparkles.update(dt);
    let grind = 0;
    let grindSide = 0;
    if (vehicle && world && dt > 0) {
      const next = new Map();
      for (const wheel of vehicle.wheelInfos) {
        if (!wheel.punctured || !HARD_SURFACES.has(wheel.surface)) continue;
        const speed = rubSpeed(wheel);
        if (speed < MIN_RUB_SPEED || !wheel.isInContact || !isWheelGrounded(world, wheel)) continue;
        if (speed > grind) {
          grind = speed;
          grindSide = wheelSide(wheel);
        }
        const due = (owed.get(wheel) ?? 0) + Math.min(MAX_SPARKS_PER_S, speed * SPARKS_PER_M) * dt;
        const count = Math.floor(due);
        next.set(wheel, due - count);
        if (count === 0) continue;
        const pos = wheel.worldTransform.position;
        sparkles.throw(pos.x, pos.y - wheel.radius, pos.z, {
          ...RIM_SPARK,
          count,
          inherit: inherit(vehicle.chassisBody.velocity, RIM_INHERIT_FRACTION),
        });
      }
      owed = next;
    }
    onGrind?.(dt, grind, grindSide);
  }

  return { update, burst, shiftOrigin: sparkles.shiftOrigin };
}
