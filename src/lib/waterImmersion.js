// Wading: samples water depth under the own car each frame. vehicle.waterDepth
// (chassis centre) feeds waterDrag.js in the physics step; vehicle.wheelSinks
// (per wheel, eased) feed car.js's syncMeshes, which lowers each wheel and
// tilts the body through them, so the car visibly drives down into deeper
// water and back up. Physics still drives on the terrain bed; the sunk meshes
// just clip through the ground.

import { waterDepthAt } from './waterDepth.js';

const MAX_SINK_M = 1;
const SINK_TIME_CONSTANT_S = 0.15; // only hides jitter at banks; the depth slope does the easing

/** @param {{ streets?: object, waterAreas?: object, rivers?: object }} layers */
export function createWaterImmersion(layers) {
  /**
   * @param {number} dt - frame delta in seconds.
   * @param {object|null} vehicle - wheeledVehicle.js vehicle (hover rigs are skipped).
   */
  function update(dt, vehicle) {
    if (!vehicle?.wheelSinks) return;
    const p = vehicle.chassisBody.position;
    vehicle.waterDepth = waterDepthAt(p.x, p.z, layers);
    const ease = 1 - Math.exp(-dt / SINK_TIME_CONSTANT_S);
    vehicle.wheelInfos.forEach((wheel, i) => {
      const pos = wheel.worldTransform.position;
      const target = Math.min(MAX_SINK_M, waterDepthAt(pos.x, pos.z, layers));
      vehicle.wheelSinks[i] += (target - vehicle.wheelSinks[i]) * ease;
    });
  }

  return { update };
}
