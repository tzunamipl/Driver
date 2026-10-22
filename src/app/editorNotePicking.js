// Scenario editor: pacenote tiles in the world answer the mouse - hover outlines one and
// shows a pointer, a click selects it (as in the panel's list), a click on nothing clears.

import * as THREE from 'three';

const CLICK_SLOP_PX = 5; // further than this between press and release = a drag, not a click

/**
 * @param {object} deps
 * @param {HTMLCanvasElement} deps.canvas
 * @param {THREE.Camera} deps.camera
 * @param {ReturnType<import('./scenarioEditor.js').createScenarioEditor>} deps.editor
 */
export function createEditorNotePicking({ canvas, camera, editor }) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let press = null;

  function noteAt(e) {
    if (!editor.state.showNoteBoards || !editor.state.doc.pacenotes?.notes.length) return -1;
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return editor.pickNote(raycaster);
  }

  function hover(i) {
    if (i !== editor.state.hoverNote) editor.setHoverNote(i);
    const cursor = i >= 0 ? 'pointer' : '';
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  }

  window.addEventListener('pointermove', (e) => {
    hover(e.pointerType === 'mouse' && e.target === canvas ? noteAt(e) : -1);
  });
  window.addEventListener('pointerdown', (e) => {
    press = e.button === 0 && e.target === canvas ? { x: e.clientX, y: e.clientY } : null;
  });
  window.addEventListener('pointerup', (e) => {
    if (!press || e.target !== canvas || Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP_PX) return;
    press = null;
    const i = noteAt(e);
    if (i >= 0 || editor.state.selectedNote >= 0) editor.selectNote(i, false);
  });
}
