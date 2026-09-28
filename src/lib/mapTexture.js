import * as THREE from 'three';

/**
 * Generates a placeholder "aerial photo" texture on a canvas so the POC
 * runs without needing a real photo file.
 *
 * To use a REAL photo instead:
 *  1. Drop your image at public/assets/map.jpg
 *  2. In main.js replace createPlaceholderMapTexture() with:
 *       new THREE.TextureLoader().load('/assets/map.jpg')
 */
export function createPlaceholderMapTexture(size = 1024) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // base field color
  ctx.fillStyle = '#3a5f3a';
  ctx.fillRect(0, 0, size, size);

  // random patchy fields for a "satellite photo" look
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(${40 + Math.random() * 40}, ${70 + Math.random() * 50}, ${40 + Math.random() * 30}, 0.6)`;
    const w = 60 + Math.random() * 200;
    const h = 60 + Math.random() * 200;
    ctx.fillRect(Math.random() * size, Math.random() * size, w, h);
  }

  // road cross (asphalt)
  ctx.fillStyle = '#4a4a4a';
  ctx.fillRect(0, size / 2 - 40, size, 80);
  ctx.fillRect(size / 2 - 40, 0, 80, size);

  // lane markings
  ctx.strokeStyle = '#e8e060';
  ctx.lineWidth = 4;
  ctx.setLineDash([30, 20]);
  ctx.beginPath();
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
