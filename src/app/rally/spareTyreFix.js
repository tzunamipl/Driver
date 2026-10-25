// Rally: with a flat tyre and the car nearly stopped, a floating button points at the
// flat wheel and swaps a spare in (hud/repairCallouts.js, car.js fitSpareTyre). On a stage
// with the clock running (or counting down) the swap adds SPARE_FIT_PENALTY_MS.

import * as THREE from 'three';
import { createRepairCallouts } from '../../hud/repairCallouts.js';
import { formatTime } from '../../hud/rallyHud.js';
import { SPARE_FIT_PENALTY_MS } from '../../lib/spareTyres.js';

// m/s: shown once this slow, kept until faster than the second (no flicker at walking pace).
const SHOW_SPEED = 0.8;
const HIDE_SPEED = 1.5;

/**
 * @param {object} deps
 * @param {HTMLCanvasElement} deps.canvas
 * @param {THREE.Camera} deps.camera
 * @param {() => object | null} deps.getVehicle
 * @param {() => boolean} deps.isEnabled
 * @param {() => object | null} deps.getRun - the current stage's stageRun.js, if any.
 * @param {(penaltyMs: number) => void} [deps.onFitted]
 * @param {() => void} [deps.onRepair] - sound when the spare goes on.
 */
export function createSpareTyreFix({ canvas, camera, getVehicle, isEnabled, getRun, onFitted, onRepair }) {
  const hud = createRepairCallouts();
  const point = new THREE.Vector3();
  let wheelIndex = -1;
  let shown = false;

  function penaltyApplies() {
    const phase = getRun()?.state.phase;
    return phase === 'countdown' || phase === 'running';
  }

  function fit() {
    const vehicle = getVehicle();
    if (wheelIndex < 0 || !vehicle?.fitSpareTyre?.(wheelIndex)) return;
    const penaltyMs = penaltyApplies() ? SPARE_FIT_PENALTY_MS : 0;
    if (penaltyMs) getRun().addPenalty(penaltyMs);
    onRepair?.();
    onFitted?.(penaltyMs);
  }

  /** Per frame, after the camera moved. */
  function update() {
    const vehicle = getVehicle();
    const speed = vehicle?.chassisBody.velocity.length() ?? Infinity;
    shown = speed < (shown ? HIDE_SPEED : SHOW_SPEED);
    wheelIndex = shown && vehicle.fitSpareTyre && isEnabled() ? vehicle.wheelInfos.findIndex((w) => w.punctured) : -1;
    if (wheelIndex < 0) return hud.render(null);
    const p = vehicle.wheelInfos[wheelIndex].worldTransform.position;
    camera.updateMatrixWorld();
    point.set(p.x, p.y, p.z).project(camera);
    if (point.z > 1) return hud.render(null); // behind the camera
    const rect = canvas.getBoundingClientRect();
    const spares = vehicle.spareTyres;
    const label = vehicle.wheelLabels?.[wheelIndex] ?? '';
    hud.render([
      {
        x: rect.left + ((point.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - point.y) / 2) * rect.height,
        label: spares ? `Fit spare wheel${label ? ` · ${label}` : ''}` : 'No spare wheel',
        note: !spares ? '' : `${spares} spare${spares > 1 ? 's' : ''} left${penaltyApplies() ? ` · adds ${formatTime(SPARE_FIT_PENALTY_MS).replace(/\.0$/, '')} to the stage time` : ''}`,
        disabled: !spares,
        onClick: fit,
      },
    ]);
  }

  return { update };
}
