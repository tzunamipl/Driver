// Vehicle registry: collects every vehicle descriptor (one per file, see
// ./gc8.js for the shape each must export) into a single list, grouped
// under a fixed set of category tabs for the lobby's vehicle picker (see
// ui/lobby.js). Adding a new vehicle later is just a new file + one more
// entry in VEHICLES below - lib/car.js's shared rig and the picker UI both
// pick it up automatically.

import gc8 from './gc8.js';
import podRacer from './podRacer.js';
import bigfoot from './bigfoot.js';

// Fixed set of tabs shown in the lobby's vehicle picker, in display order.
// `id` is what's actually stored/selected; `label` is only for display.
export const CATEGORIES = [
  { id: 'misc', label: 'Misc' },
  { id: 'cars', label: 'Cars' },
  { id: 'chariots-of-fire', label: 'Chariots of Fire' },
];

// Every selectable vehicle, regardless of category - add new ones here
// once their own file exists. Empty categories are still shown as tabs
// with an empty list (see CATEGORIES above).
export const VEHICLES = [gc8, podRacer, bigfoot];

export const DEFAULT_VEHICLE_ID = bigfoot.id;

const byId = new Map(VEHICLES.map((v) => [v.id, v]));

/** Looks up a vehicle by id, falling back to the default if unknown/missing. */
export function getVehicle(id) {
  return byId.get(id) ?? byId.get(DEFAULT_VEHICLE_ID);
}

/** Vehicles belonging to one category tab, in registry order. */
export function vehiclesInCategory(categoryId) {
  return VEHICLES.filter((v) => v.category === categoryId);
}
