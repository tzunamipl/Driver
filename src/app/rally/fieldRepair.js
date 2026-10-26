// Rally field fixes: with the car nearly stopped, a floating button on each part the crew can
// patch at the roadside (lib/serviceRepairs.js 'field' actions: spare wheel, shocks, radiator,
// sump, gearbox, lamps, pouring in the cans); Inspect car offers the same. On a stage with the
// clock running (or counting down) each one adds its penalty to the stage time.

import { createPartCallouts } from '../partCallouts.js';
import { carParts } from '../../lib/serviceRepairs.js';
import { formatTime } from '../../hud/rallyHud.js';

export const penaltyText = (ms) => `+${formatTime(ms).replace(/\.0$/, '')}`;

/**
 * @param {object} deps
 * @param {HTMLCanvasElement} deps.canvas
 * @param {THREE.Camera} deps.camera
 * @param {() => object | null} deps.getVehicle
 * @param {() => boolean} deps.isEnabled
 * @param {() => object | null} deps.getRun - the current stage's stageRun.js, if any.
 * @param {(text: string, penaltyMs: number, clockMin: number) => void} [deps.onDone] - `text`: what was done; `clockMin`: rally clock minutes it took.
 * @param {() => void} [deps.onRepair] - sound of the repair.
 */
export function createFieldRepair({ canvas, camera, getVehicle, isEnabled, getRun, onDone, onRepair }) {
  const callouts = createPartCallouts({ canvas, camera });

  function penaltyApplies() {
    const phase = getRun()?.state.phase;
    return phase === 'countdown' || phase === 'running';
  }

  /** Does a carParts() field action on `part`, with its stage penalty. */
  function apply(action, part) {
    if (action.disabled || !getVehicle() || !isEnabled()) return;
    if (action.apply() === false) return;
    const penaltyMs = penaltyApplies() ? action.penaltyMs ?? 0 : 0;
    if (penaltyMs) getRun().addPenalty(penaltyMs);
    onRepair?.();
    onDone?.(`${action.label} · ${part.label}`, penaltyMs, action.clockMin ?? 0);
  }

  function items(vehicle) {
    const live = penaltyApplies();
    return carParts(vehicle).flatMap((part) =>
      !part.anchor
        ? []
        : part.actions
            .filter((a) => a.kind === 'field')
            .map((a) => ({
              anchor: part.anchor,
              label: a.disabled ? a.label : `${a.label} · ${part.label}`,
              note: [a.note ?? part.note, live && a.penaltyMs && !a.disabled ? `adds ${penaltyText(a.penaltyMs)} to the stage time` : ''].filter(Boolean).join(' · '),
              disabled: a.disabled,
              onClick: () => apply(a, part),
            }))
    );
  }

  /** Per frame, after the camera moved. */
  function update() {
    callouts.update(isEnabled() ? getVehicle() : null, items);
  }

  return { update, apply, penaltyApplies };
}
