// Debug view: tooltip at the mouse naming the landcover under it (every polygon
// there, overlay-only classes too). Only while the Landcover overlay is shown.

import * as THREE from 'three';

const REFRESH_MS = 200; // also re-checks a still mouse while the camera moves
const OFFSET_PX = 14;

/**
 * @param {object} deps
 * @param {HTMLElement} deps.el - tooltip element
 * @param {HTMLCanvasElement} deps.canvas - the renderer's canvas
 * @param {THREE.Camera} deps.camera
 * @param {import('../lib/landcoverAreas.js').LandcoverAreasManager} deps.landcoverAreas
 */
export function createLandcoverHover({ el, canvas, camera, landcoverAreas }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let mouse = null; // { x, y } client px while over the canvas

  function hide() {
    el.style.display = 'none';
  }

  function refresh() {
    if (!mouse) return hide();
    const rect = canvas.getBoundingClientRect();
    ndc.set(((mouse.x - rect.left) / rect.width) * 2 - 1, -((mouse.y - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = landcoverAreas.raycastOverlay(raycaster);
    const labels = hit ? landcoverAreas.labelsAt(hit.x, hit.z) : [];
    if (!labels.length) return hide();
    el.textContent = labels.join('\n');
    el.style.left = `${mouse.x + OFFSET_PX}px`;
    el.style.top = `${mouse.y + OFFSET_PX}px`;
    el.style.display = 'block';
  }

  // On window: HUD layers above the canvas are click-through, so the target tells if it's really over the scene.
  window.addEventListener('pointermove', (e) => {
    mouse = e.pointerType === 'mouse' && e.target === canvas ? { x: e.clientX, y: e.clientY } : null;
    refresh();
  });
  document.addEventListener('pointerleave', () => {
    mouse = null;
    hide();
  });
  setInterval(refresh, REFRESH_MS);
  hide();
}
