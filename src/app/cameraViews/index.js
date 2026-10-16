// Camera view registry, cycled with C. Each file overrides only what
// differs from the shared config.js defaults (see ./chase.js). A view may
// set `vehicleTypes` to apply only to those descriptor.vehicleType values.

import chase from './chase.js';
import close from './close.js';
import far from './far.js';
import hood from './hood.js';
import rearSide from './rearSide.js';
import side from './side.js';
import pod from './pod.js';
import drone from './drone.js';

// Cycle order.
export const CAMERA_VIEWS = [chase, close, far, hood, rearSide, side, pod, drone];

export const DEFAULT_CAMERA_VIEW_ID = chase.id;

const byId = new Map(CAMERA_VIEWS.map((v) => [v.id, v]));

/** Whether `view` applies to `vehicleType` (null = not known yet = matches all). */
export function viewMatchesVehicle(view, vehicleType) {
  return !view.vehicleTypes || vehicleType === null || view.vehicleTypes.includes(vehicleType);
}

/** View by id, or the default if unknown or not applicable to the vehicle. */
export function getCameraView(id, vehicleType) {
  const view = byId.get(id) ?? byId.get(DEFAULT_CAMERA_VIEW_ID);
  return viewMatchesVehicle(view, vehicleType) ? view : byId.get(DEFAULT_CAMERA_VIEW_ID);
}

/** Next applicable view after `id` (wrapping), or the default. */
export function nextCameraView(id, vehicleType) {
  const idx = CAMERA_VIEWS.findIndex((v) => v.id === id);
  for (let step = 1; step <= CAMERA_VIEWS.length; step++) {
    const candidate = CAMERA_VIEWS[(idx + step) % CAMERA_VIEWS.length];
    if (viewMatchesVehicle(candidate, vehicleType)) return candidate;
  }
  return byId.get(DEFAULT_CAMERA_VIEW_ID);
}

