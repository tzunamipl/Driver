// Debug view: tooltip at the mouse naming the ground under it - the tyre-grip
// surface key (road, builtUp, normal, ...) plus every landcover polygon there
// (overlay-only classes too). Only while a surface overlay is shown.

import * as THREE from 'three';
import { classifySurfaceAt } from '../lib/terrainSurface.js';

// The raycast tests every visible tile's triangles (~15 ms): never per pointer event.
const REFRESH_MS = 100; // also re-checks a still mouse while the camera moves
const OFFSET_PX = 14;

/**
 * @param {object} deps
 * @param {HTMLElement} deps.el - tooltip element
 * @param {HTMLCanvasElement} deps.canvas - the renderer's canvas
 * @param {THREE.Camera} deps.camera
 * @param {import('../lib/terrain.js').TerrainManager} deps.terrain
 * @param {Parameters<typeof classifySurfaceAt>[2] & { landcoverAreas: import('../lib/landcoverAreas.js').LandcoverAreasManager }} deps.layers
 */
export function createSurfaceHover({ el, canvas, camera, terrain, layers }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let mouse = null; // { x, y } client px while over the canvas

  function hide() {
    el.style.display = 'none';
  }

  function refresh() {
    if (!mouse || !Object.values(layers).some((layer) => layer?.visible)) return hide();
    const rect = canvas.getBoundingClientRect();
    ndc.set(((mouse.x - rect.left) / rect.width) * 2 - 1, -((mouse.y - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = terrain.raycast(raycaster);
    if (!hit) return hide();
    const landcover = layers.landcoverAreas.labelsAt(hit.x, hit.z);
    el.textContent = [`surface: ${classifySurfaceAt(hit.x, hit.z, layers)}`, ...landcover].join('\n');
    place();
    el.style.display = 'block';
  }

  function place() {
    el.style.left = `${mouse.x + OFFSET_PX}px`;
    el.style.top = `${mouse.y + OFFSET_PX}px`;
  }

  // On window: HUD layers above the canvas are click-through, so the target tells if it's really over the scene.
  window.addEventListener('pointermove', (e) => {
    mouse = e.pointerType === 'mouse' && e.target === canvas ? { x: e.clientX, y: e.clientY } : null;
    if (mouse) place();
    else hide();
  });
  document.addEventListener('pointerleave', () => {
    mouse = null;
    hide();
  });
  setInterval(refresh, REFRESH_MS);
  hide();
}
