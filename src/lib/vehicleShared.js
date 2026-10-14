// Pieces shared by the wheeled (car.js) and hover (chariot.js) rigs. Lives
// apart from both so chariot.js needn't import car.js (which imports it).

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { findGroundY } from './terrain.js';

// Tags every vehicle's collision shapes; physicsSetup.js pairs it with
// ground/building materials (low friction so wall hits slide, not stick).
export const CHASSIS_MATERIAL = new CANNON.Material('chassis');

function makeNameSprite(name, score = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(16, 16, 480, 96);
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 48px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${name}  ${score}`, 256, 64);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.position.set(0, 6.2, 0);
  sprite.scale.set(5.2, 1.3, 1);
  sprite.renderOrder = 1;
  return sprite;
}

/** Name + score plate parented by the caller (local chassis or a remote vehicle). */
export function createNameTag(name, score = 0) {
  const sprite = makeNameSprite(name, score);
  let currentName = name;
  let currentScore = score;

  function set(nextName, nextScore = 0) {
    const safeScore = Number.isFinite(nextScore) ? nextScore : 0;
    if (nextName === currentName && safeScore === currentScore) return;
    currentName = nextName;
    currentScore = safeScore;
    const previous = sprite.material;
    sprite.material = makeNameSprite(nextName, safeScore).material;
    previous.map?.dispose();
    previous.dispose();
  }

  return { sprite, set };
}

/** How long a reset eases the vehicle up into its upright pose. */
export const RESET_LIFT_DURATION_S = 0.6;

/** Ease-out progress (0..1) of a reset lift after `elapsed` seconds. */
export function resetLiftProgress(elapsed) {
  const t = Math.min(elapsed / RESET_LIFT_DURATION_S, 1);
  return { t, eased: 1 - (1 - t) * (1 - t) };
}

/** Body's current heading (yaw) with roll/pitch zeroed. */
export function uprightQuaternion(body) {
  const euler = new CANNON.Vec3();
  body.quaternion.toEuler(euler);
  const upright = new CANNON.Quaternion();
  upright.setFromEuler(0, euler.y, 0);
  return upright;
}

/**
 * In-place reset target: `lift` metres above the higher of the body's
 * position and the terrain under it (recovers vehicles stuck underground).
 */
export function liftedResetPosition(world, body, lift) {
  const target = body.position.clone();
  const groundY = findGroundY(world, target.x, target.z);
  if (groundY !== null && groundY > target.y) target.y = groundY;
  target.y += lift;
  return target;
}

/** Wireframe material for debug hitbox meshes (drawn on top). */
export function createHitboxMaterial() {
  return new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, depthTest: false });
}

/** Hidden, on-top debug mesh for a hitbox. */
export function hitboxMesh(geometry, material) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = false;
  mesh.renderOrder = 999;
  return mesh;
}

/**
 * Appearance/teardown for a remote (visual-only) vehicle whose body is
 * `group` coloured through `bodyMat`; adds `group` to the scene.
 */
export function createRemoteShell(scene, group, bodyMat, color, name, score) {
  const nameTag = createNameTag(name, score);
  group.add(nameTag.sprite);
  scene.add(group);
  let currentColor = color;

  function setAppearance(nextColor, nextName, nextScore = 0) {
    if (nextColor !== currentColor) {
      currentColor = nextColor;
      bodyMat.color.set(nextColor);
    }
    nameTag.set(nextName, nextScore);
  }

  function dispose() {
    scene.remove(group);
    const materials = new Set();
    const geometries = new Set();
    group.traverse((obj) => {
      if (obj.geometry) geometries.add(obj.geometry);
      if (obj.material) {
        materials.add(obj.material);
        if (obj.material.map) obj.material.map.dispose();
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }

  return { setAppearance, dispose };
}
