// Small shared pieces used by both lib/car.js (wheeled vehicles) and
// lib/chariot.js (hover vehicles) - kept in their own file specifically so
// neither of those two files needs to import the other (car.js dispatches
// to chariot.js for "hover" vehicle kinds - see car.js's createCar/
// createRemoteCar - so chariot.js importing back from car.js would be a
// circular import).

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

// Shared CANNON.Material tagging every vehicle's chassis collision shapes,
// so main.js can pair it with BUILDING_MATERIAL/GROUND_MATERIAL (see
// app/physicsSetup.js) in dedicated ContactMaterials - lower friction than
// the world default so a glancing hit against a wall slides/bounces off
// instead of grabbing and stopping the vehicle dead. Re-exported from
// car.js for every existing call site that already imports it from there.
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
