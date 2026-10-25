// Rally service props in the world answer the mouse: hovering the tyre rack, the fuel bowser or a service bay
// outlines it (yellow when the car is stopped close by, grey otherwise) and a click opens its
// dialog again (controlScenery.js pickAction).

import * as THREE from 'three';

const CLICK_SLOP_PX = 5; // further than this between press and release = a drag, not a click
const USE_RANGE_M = 25; // car within this of the props
const USE_SPEED = 1; // m/s: counts as stopped

/**
 * @param {object} deps
 * @param {HTMLCanvasElement} deps.canvas
 * @param {THREE.Camera} deps.camera
 * @param {object} deps.scenery - controlScenery.js
 * @param {() => object | null} deps.getVehicle
 * @param {() => boolean} deps.isEnabled
 * @param {(action: string, picked: { index?: number }) => void} deps.onAction - 'tyres' | 'refuel' | 'service' | 'remoteService'; picked: controlScenery.js pickAction()
 */
export function createZonePicking({ canvas, camera, scenery, getVehicle, isEnabled, onAction }) {
  const raycaster = new THREE.Raycaster();
  let ndc = null; // mouse over the canvas, else null
  let press = null;
  let hovered = null; // { picked, ready }

  function usable(picked) {
    const body = getVehicle()?.chassisBody;
    if (!body) return false;
    return Math.hypot(body.position.x - picked.x, body.position.z - picked.z) < USE_RANGE_M && body.velocity.length() < USE_SPEED;
  }

  /** Picks again under the mouse: the camera and the car move under a resting cursor. */
  function refresh() {
    let picked = null;
    if (ndc && isEnabled()) {
      raycaster.setFromCamera(ndc, camera);
      picked = scenery.pickAction(raycaster);
    }
    const ready = !!picked && usable(picked);
    hovered = picked ? { picked, ready } : null;
    scenery.setOutline(picked, picked ? (ready ? 'ready' : 'far') : null);
    const cursor = ready ? 'pointer' : '';
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
    const title = picked && !ready ? 'Stop the car next to it' : '';
    if (canvas.title !== title) canvas.title = title;
  }

  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || e.target !== canvas) {
      ndc = null;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  });
  window.addEventListener('pointerdown', (e) => {
    press = e.button === 0 && e.target === canvas ? { x: e.clientX, y: e.clientY } : null;
  });
  window.addEventListener('pointerup', (e) => {
    if (!press || e.target !== canvas || Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP_PX) return;
    press = null;
    refresh();
    if (!hovered?.ready) return;
    const { picked } = hovered;
    ndc = null; // the dialog covers the canvas; no outline left behind it
    refresh();
    onAction(picked.action, picked);
  });

  return {
    /** Per frame. */
    update: refresh,
  };
}
