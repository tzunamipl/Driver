// Raycast hover repulsor shared by the pod racer's engines and pod.

import * as THREE from 'three';
import { GROUND_COLLISION_GROUP } from '../terrain.js';
import { BUILDING_COLLISION_GROUP } from '../buildings.js';

export const HOVER_REST_HEIGHT = 4.15;
const HOVER_MAX_RAY = HOVER_REST_HEIGHT * 3;
const HOVER_RAYCAST_MASK = GROUND_COLLISION_GROUP | BUILDING_COLLISION_GROUP;

/**
 * Spring-damper force at one point. Clearances inside [minEngage, maxEngage]
 * are force-free; below pushes up, above pulls down (so thrust can't climb
 * forever). No ray hit counts as HOVER_MAX_RAY clearance. Scratch ray
 * objects are passed in to avoid per-step allocation.
 * @returns {{force: number, clearance: number, grounded: boolean}}
 */
export function hoverAt(
  world,
  worldPos,
  verticalVelocity,
  { rayFrom, rayTo, rayResult },
  { stiffness, damping, maxForce, minEngage = HOVER_REST_HEIGHT, maxEngage = HOVER_REST_HEIGHT }
) {
  rayFrom.set(worldPos.x, worldPos.y + 0.25, worldPos.z);
  rayTo.set(worldPos.x, worldPos.y - HOVER_MAX_RAY, worldPos.z);
  rayResult.reset();
  world.raycastClosest(rayFrom, rayTo, { collisionFilterMask: HOVER_RAYCAST_MASK }, rayResult);
  const clearance = rayResult.hasHit ? worldPos.y - rayResult.hitPointWorld.y : HOVER_MAX_RAY;

  let compression = 0;
  if (clearance < minEngage) compression = minEngage - clearance;
  else if (clearance > maxEngage) compression = maxEngage - clearance;

  const force = compression === 0 ? 0 : THREE.MathUtils.clamp(compression * stiffness - verticalVelocity * damping, -maxForce, maxForce);
  return { force, clearance, grounded: clearance < HOVER_REST_HEIGHT + 0.3 };
}
