// Sparse, cheap distant cumulus clouds (heaped puffs) that fade in at the
// far horizon and fade out once left behind.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FAR_RADIUS_METERS, applyGroundHaze } from './terrain.js';

const MAX_CLOUDS = 40;
// New clouds spawn only near the far edge, never in front of the player.
const SPAWN_RADIUS_MIN = FAR_RADIUS_METERS * 0.1;
const SPAWN_RADIUS_MAX = FAR_RADIUS_METERS * 0.98;
// Despawn radius, beyond the spawn ring so approached clouds aren't yanked.
const DESPAWN_RADIUS = FAR_RADIUS_METERS * 1.05;
const MIN_HEIGHT_METERS = 3_000;
const MAX_HEIGHT_METERS = 6_000;
const FADE_MS = 2_000;
// Seconds between spawns (they trickle in).
const SPAWN_INTERVAL_MIN_S = 3;
const SPAWN_INTERVAL_MAX_S = 7;
const MIN_CLOUD_SEPARATION_METERS = 7_000;
// Attempts per spawn to find a spot clear of other clouds.
const MAX_SPAWN_ATTEMPTS = 10;

const CLOUD_COLOR = 0xC5D8F0;
const CLOUD_SHAPE_VARIANTS = 6;
const PUFF_GEOMETRY = new THREE.SphereGeometry(1, 10, 8);

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function addPuff(puffs, x, y, z, r) {
  puffs.push(PUFF_GEOMETRY.clone().scale(r, r, r).translate(x, y, z));
}

/**
 * Cumulus in unit space: overlapping puffs heaped into a dome over a flat base
 * at y = 0, about 2 wide along x, 1.2 along z and 1 tall.
 */
function buildCumulusGeometry() {
  const puffs = [];
  const baseCount = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < baseCount; i++) {
    const x = -0.75 + (1.5 * i) / (baseCount - 1) + randomRange(-0.08, 0.08);
    addPuff(puffs, x, randomRange(0.15, 0.3), randomRange(-0.25, 0.25), randomRange(0.35, 0.5));
  }
  for (let i = 0; i < 3; i++) {
    addPuff(puffs, randomRange(-0.5, 0.5), randomRange(0.45, 0.6), randomRange(-0.2, 0.2), randomRange(0.3, 0.42));
  }
  addPuff(puffs, randomRange(-0.25, 0.25), randomRange(0.7, 0.8), randomRange(-0.1, 0.1), randomRange(0.25, 0.35));
  // Depth puffs so it isn't a flat wall from the side.
  addPuff(puffs, randomRange(-0.3, 0.3), 0.25, 0.4, randomRange(0.3, 0.4));
  addPuff(puffs, randomRange(-0.3, 0.3), 0.25, -0.4, randomRange(0.3, 0.4));

  const geometry = mergeGeometries(puffs, false);
  for (const puff of puffs) puff.dispose();
  // Flat underside, the cumulus signature.
  const pos = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < 0) {
      pos.setY(i, 0);
      normal.setXYZ(i, 0, -1, 0);
    }
  }
  return geometry;
}

const CLOUD_GEOMETRIES = Array.from({ length: CLOUD_SHAPE_VARIANTS }, buildCumulusGeometry);

/** Creates the cloud effect. Call update() once per frame. */
export function createClouds(scene) {
  const pool = [];
  for (let i = 0; i < MAX_CLOUDS; i++) {
    // Own material per cloud for independent fading.
    const material = new THREE.MeshStandardMaterial({
      color: CLOUD_COLOR,
      transparent: false,
      opacity: 0,
      // Overlapping puffs need depth to hide each other's inner faces.
      depthWrite: true,
      roughness: 1,
      metalness: 0,
      // Beyond scene.fog's range; hazed like the terrain instead.
      fog: false,
    });
    material.onBeforeCompile = applyGroundHaze;
    const mesh = new THREE.Mesh(CLOUD_GEOMETRIES[0], material);
    mesh.visible = false;
    scene.add(mesh);
    pool.push({ mesh, material, active: false, fadingOut: false, targetOpacity: 0 });
  }

  let spawnTimer = 0;
  let seeded = false;

  /** True if (x, y, z) clears MIN_CLOUD_SEPARATION_METERS from every currently-active cloud. */
  function isFarEnoughFromActiveClouds(x, y, z) {
    for (const p of pool) {
      if (!p.active) continue;
      const dx = p.mesh.position.x - x;
      const dy = p.mesh.position.y - y;
      const dz = p.mesh.position.z - z;
      if (Math.hypot(dx, dy, dz) < MIN_CLOUD_SEPARATION_METERS) return false;
    }
    return true;
  }

  function spawnCloud(playerX, playerZ, playerY, { scattered } = {}) {
    const slot = pool.find((p) => !p.active);
    if (!slot) return;

    // Skip this spawn if no clear spot is found.
    let x, y, z;
    let found = false;
    for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      // Initial populate scatters across the whole radius.
      const dist = scattered
        ? randomRange(SPAWN_RADIUS_MIN * 0.3, SPAWN_RADIUS_MAX)
        : randomRange(SPAWN_RADIUS_MIN, SPAWN_RADIUS_MAX);
      x = playerX + Math.cos(angle) * dist;
      z = playerZ + Math.sin(angle) * dist;
      y = playerY + randomRange(MIN_HEIGHT_METERS, MAX_HEIGHT_METERS);
      if (isFarEnoughFromActiveClouds(x, y, z)) {
        found = true;
        break;
      }
    }
    if (!found) return;

    const size = randomRange(900, 2_200);
    // Broader than tall: spread the puffs out more than they stack up.
    const spread = randomRange(1.3, 1.7);
    slot.mesh.geometry = CLOUD_GEOMETRIES[Math.floor(Math.random() * CLOUD_GEOMETRIES.length)];
    slot.mesh.position.set(x, y, z);
    slot.mesh.scale.set(size * spread, size * randomRange(0.7, 1.0), size * spread);
    slot.mesh.rotation.y = Math.random() * Math.PI * 2;

    slot.material.opacity = 0;
    slot.targetOpacity = randomRange(0.55, 0.85);
    slot.mesh.visible = true;
    slot.active = true;
    slot.fadingOut = false;
  }

  /**
   * @param {number} dt - frame delta in seconds.
   * @param {number} playerX
   * @param {number} playerZ
   * @param {number} playerY - clouds spawn MIN..MAX_HEIGHT_METERS above this.
   */
  function update(dt, playerX, playerZ, playerY) {
    if (!seeded) {
      seeded = true;
      for (let i = 0; i < MAX_CLOUDS; i++) spawnCloud(playerX, playerZ, playerY, { scattered: true });
    }

    const fadeStep = (dt * 1000) / FADE_MS;
    let activeCount = 0;
    for (const p of pool) {
      if (!p.active) continue;
      activeCount++;

      const dx = p.mesh.position.x - playerX;
      const dz = p.mesh.position.z - playerZ;
      const dist = Math.hypot(dx, dz);
      if (dist > DESPAWN_RADIUS) p.fadingOut = true;

      if (p.fadingOut) {
        p.material.opacity -= p.targetOpacity * fadeStep;
        if (p.material.opacity <= 0) {
          p.active = false;
          p.mesh.visible = false;
          activeCount--;
        }
      } else if (p.material.opacity < p.targetOpacity) {
        p.material.opacity = Math.min(p.targetOpacity, p.material.opacity + p.targetOpacity * fadeStep);
      }
    }

    spawnTimer -= dt;
    if (spawnTimer <= 0 && activeCount < MAX_CLOUDS) {
      spawnCloud(playerX, playerZ, playerY);
      spawnTimer = randomRange(SPAWN_INTERVAL_MIN_S, SPAWN_INTERVAL_MAX_S);
    }
  }

  return { update };
}
