// Distant high-altitude clouds: a handful of simple, elongated billboard-
// like shapes that drift into existence at the far horizon (the same
// maximum reach as the FAR terrain backdrop tier - see terrain.js's
// FAR_RADIUS_METERS) and fade back out once the player has driven far
// enough that they've fallen well behind/away again. Deliberately sparse
// (never more than MAX_CLOUDS concurrently) and simple (a single shared,
// non-uniformly-scaled sphere geometry per cloud, no texture/shading) -
// this is just a cheap sense of sky-scale, not a real cloud sim.

import * as THREE from 'three';
import { FAR_RADIUS_METERS } from './terrain.js';

// Never more than this many clouds exist at once (comfortably inside the
// "no more than 10-20" the look is tuned for).
const MAX_CLOUDS = 20;
// New clouds only spawn at the outer edge of the world (near the FAR tier's
// own max reach), so they always read as rising out of the same horizon the
// low-detail backdrop fades in from - never conjured up right in front of
// the player.
const SPAWN_RADIUS_MIN = FAR_RADIUS_METERS * 0.1;
const SPAWN_RADIUS_MAX = FAR_RADIUS_METERS * 0.98;
// A cloud is only despawned once it's drifted (relative to the player, who
// is the only thing that actually moves here) past this radius - a bit
// further out than SPAWN_RADIUS_MAX so one the player drives straight
// toward doesn't get yanked away mid-approach, only once it's fallen behind
// again.
const DESPAWN_RADIUS = FAR_RADIUS_METERS * 1.05;
const MIN_HEIGHT_METERS = 3_000;
const MAX_HEIGHT_METERS = 6_000;
// Opacity eases in/out over this many ms so clouds never hard-pop in/out at
// the spawn/despawn radius.
const FADE_MS = 2_000;
// How often (seconds) a new cloud is allowed to spawn once the pool has
// room - spawns trickle in one at a time rather than appearing all together.
const SPAWN_INTERVAL_MIN_S = 3;
const SPAWN_INTERVAL_MAX_S = 7;
// Minimum allowed distance (3D) between a newly-spawned cloud and every
// other currently-active one, so sparse clouds never spawn overlapping or
// visibly bunched up right next to each other.
const MIN_CLOUD_SEPARATION_METERS = 3_000;
// Candidate spawn spots are retried this many times looking for one that
// clears MIN_CLOUD_SEPARATION_METERS before giving up for this attempt
// (the next spawn timer tick just tries again).
const MAX_SPAWN_ATTEMPTS = 10;

// Single shared geometry, non-uniformly scaled per-cloud (below) to get a
// simple elongated "streak" shape instead of a sphere - cheap and avoids
// needing any actual cloud texture/shader.
const CLOUD_GEOMETRY = new THREE.SphereGeometry(3, 8, 6);
const CLOUD_COLOR = 0xf5f7fa;
// Fixed world-space yaw every cloud's long axis is stretched along (see
// spawnCloud below) - shared by all clouds so they all read as elongated
// in the same direction, rather than each pointing a random way.
const CLOUD_YAW_RADIANS = 0;

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

/** Creates the distant-cloud effect. Call update() once per rendered frame (see app/mainLoop.js). */
export function createClouds(scene) {
  const pool = [];
  for (let i = 0; i < MAX_CLOUDS; i++) {
    // One material per cloud (not shared) so each can fade in/out
    // independently, same tradeoff the other particle-ish effects in this
    // folder make (see bodyDust.js/tireSmoke.js).
    const material = new THREE.MeshBasicMaterial({
      color: CLOUD_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      // Clouds live far beyond scene.fog's own fog-out distance (see
      // sceneSetup.js) - without this they'd always render fully
      // fog-tinted/invisible no matter how close the player drives,
      // exactly like the FAR terrain backdrop tier opts out for the same
      // reason (see terrain.js).
      fog: false,
    });
    const mesh = new THREE.Mesh(CLOUD_GEOMETRY, material);
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

    // Retry a handful of candidate spots looking for one that isn't
    // bunched up right against an already-active cloud; if none clears it
    // within MAX_SPAWN_ATTEMPTS, just skip this spawn attempt entirely
    // (the next spawn timer tick tries again) rather than spawning
    // overlapping clouds anyway.
    let x, y, z;
    let found = false;
    for (let attempt = 0; attempt < MAX_SPAWN_ATTEMPTS; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      // On first populate, scatter clouds across the whole visible radius
      // (not just the far edge) so the sky isn't empty while the
      // trickle-spawn timer slowly fills the rest in - every spawn after
      // that is always at the far ring, per the doc comment above.
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

    // Elongated: long on one horizontal axis, thin vertically, moderate on
    // the other horizontal axis - all clouds share the same fixed yaw (see
    // CLOUD_YAW_RADIANS) so they all stretch the same way, like a
    // prevailing-wind-aligned streak pattern, instead of pointing every
    // which way.
    const length = randomRange(800, 2_600);
    const thickness = randomRange(120, 340);
    const width = randomRange(300, 800);
    slot.mesh.position.set(x, y, z);
    slot.mesh.scale.set(length, thickness, width);
    slot.mesh.rotation.y = CLOUD_YAW_RADIANS;

    slot.material.opacity = 0;
    slot.targetOpacity = randomRange(0.55, 0.85);
    slot.mesh.visible = true;
    slot.active = true;
    slot.fadingOut = false;
  }

  /**
   * @param {number} dt - frame delta in seconds.
   * @param {number} playerX - player's current world X.
   * @param {number} playerZ - player's current world Z.
   * @param {number} playerY - player's current world Y (clouds spawn this
   *   high plus MIN_HEIGHT_METERS-MAX_HEIGHT_METERS, i.e. "above ground"
   *   relative to wherever the player currently is).
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
