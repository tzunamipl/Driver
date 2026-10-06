// Camera view registry: collects every selectable camera view (one per
// file, see ./chase.js for the shape each descriptor can override) into a
// single ordered list that app/cameraFollow.js cycles through on the "C"
// key - the same registry-of-descriptors pattern as
// lib/vehicles/index.js (vehicles) and lib/surfaceCompounds.js
// (surfaces): shared tuning lives once in config.js/the rig itself, and
// each file here only states what's actually distinct about that one
// view. Adding a new view later is just a new file + one more entry in
// CAMERA_VIEWS below.
//
// A view may also declare `vehicleTypes: [...]` (see ./pod.js) to opt
// into only the matching lib/vehicles/*.js descriptor.vehicleType(s) -
// e.g. the pod cam only makes sense mounted on a hover chariot's actual
// pod, not a wheeled car. viewMatchesVehicle()/getCameraView()/
// nextCameraView() below all honor that restriction; a view with no
// `vehicleTypes` at all (the common case) matches every vehicle.

import chase from './chase.js';
import close from './close.js';
import far from './far.js';
import hood from './hood.js';
import rearSide from './rearSide.js';
import pod from './pod.js';

// Every selectable camera view, in cycle order (the order "C" steps
// through them).
export const CAMERA_VIEWS = [chase, close, far, hood, rearSide, pod];

export const DEFAULT_CAMERA_VIEW_ID = chase.id;

const byId = new Map(CAMERA_VIEWS.map((v) => [v.id, v]));

/** Whether `view` is applicable to a vehicle of `vehicleType` (the
 * descriptor's own `vehicleType` field - see lib/car.js/lib/chariot.js -
 * e.g. `'hover'` for Chariots of Fire, undefined for ordinary wheeled
 * cars). `vehicleType === null` specifically (as opposed to merely
 * undefined, which just means "a real vehicle that doesn't set one") is
 * the "not resolved yet" sentinel - treated as "matches anything" so
 * views aren't spuriously hidden before any vehicle has spawned. */
export function viewMatchesVehicle(view, vehicleType) {
  return !view.vehicleTypes || vehicleType === null || view.vehicleTypes.includes(vehicleType);
}

/** Looks up a view by id, falling back to the default if unknown/missing
 * (e.g. a stale id from an older build left in localStorage) or no longer
 * applicable to the current vehicle (e.g. the pod cam was active and the
 * player swapped to a wheeled car mid-drive). */
export function getCameraView(id, vehicleType) {
  const view = byId.get(id) ?? byId.get(DEFAULT_CAMERA_VIEW_ID);
  return viewMatchesVehicle(view, vehicleType) ? view : byId.get(DEFAULT_CAMERA_VIEW_ID);
}

/** The next view after `id` in cycle order that's applicable to
 * `vehicleType`, wrapping back to the first after the last and skipping
 * any view that isn't (e.g. cycling past the pod cam while driving a
 * car). Falls back to the default view if nothing else matches. */
export function nextCameraView(id, vehicleType) {
  const idx = CAMERA_VIEWS.findIndex((v) => v.id === id);
  for (let step = 1; step <= CAMERA_VIEWS.length; step++) {
    const candidate = CAMERA_VIEWS[(idx + step) % CAMERA_VIEWS.length];
    if (viewMatchesVehicle(candidate, vehicleType)) return candidate;
  }
  return byId.get(DEFAULT_CAMERA_VIEW_ID);
}

