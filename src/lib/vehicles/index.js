// Vehicle registry: collects every vehicle descriptor (one per file, see
// ./gc8.js for the shape each must export) into a single list, grouped
// under a fixed set of category tabs for the lobby's vehicle picker (see
// ui/lobby.js). Adding a new vehicle later is just a new file + one more
// entry in VEHICLES below - lib/car.js's shared rig and the picker UI both
// pick it up automatically.

import gc8 from './gc8.js';
import gl from './gl.js';
import levorg from './levorg.js';
import podRacer from './podRacer.js';
import bigfoot from './bigfoot.js';
import speeder from './speeder.js';
import rally from './rally.js'
import evo6 from './evo6.js';
import hemtt from './hemtt.js';
import warRig from './warRig.js';
import impreza22b from './impreza22b.js';
import focusWrc from './focusWrc.js';
import { setPaintGloss } from './geometry/paint.js';
import scaniaR from './scaniaR.js';
import actros from './actros.js';
import interceptor from './interceptor.js';
import gigahorse from './gigahorse.js';
import cinquecento from './cinquecento.js';
import golf5 from './golf5.js';


// Fixed set of tabs shown in the lobby's vehicle picker, in display order.
// `id` is what's actually stored/selected; `label` is only for display.
export const CATEGORIES = [
  { id: 'misc', label: 'Misc' },
  { id: 'cars', label: 'Cars' },
  { id: 'chariots-of-fire', label: 'Chariots of Fire' },
  { id: 'wrc', label: 'WRC' },
  { id: 'trucks', label: 'Trucks' },
  { id: 'fury-road', label: 'Fury Road' },
];

// Every selectable vehicle, regardless of category - add new ones here
// once their own file exists. Empty categories are still shown as tabs
// with an empty list (see CATEGORIES above).
export const VEHICLES = [gc8, gl, levorg, cinquecento, golf5, podRacer, bigfoot, speeder, rally, evo6, impreza22b, focusWrc, hemtt, actros, scaniaR, warRig, gigahorse, interceptor];

// Optional descriptor `gloss` (0 matte .. 1 full clearcoat, default) for the body paint;
// a trailer may set its own `gloss`, otherwise it inherits the tractor's.

/** Wraps a body builder so the paint it returns gets the descriptor's `gloss`. */
function withGloss(build, gloss) {
  return (...args) => {
    const built = build(...args);
    if (built.bodyMat) setPaintGloss(built.bodyMat, gloss);
    return built;
  };
}
// Chiselled look like the scenery: every body material is flat-shaded.

/** Wraps a body builder so every material in the group it returns is flat-shaded. */
function withFlatShading(build) {
  return (...args) => {
    const built = build(...args);
    built.group.traverse((obj) => {
      if (!obj.material) return;
      for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
        if (m.flatShading) continue;
        m.flatShading = true;
        m.needsUpdate = true;
      }
    });
    return built;
  };
}
for (const v of VEHICLES) {
  v.buildBody = withFlatShading(v.buildBody);
  if (v.trailer) v.trailer.buildBody = withFlatShading(v.trailer.buildBody);
  if (v.gloss !== undefined) v.buildBody = withGloss(v.buildBody, v.gloss);
  const trailerGloss = v.trailer?.gloss ?? v.gloss;
  if (v.trailer && trailerGloss !== undefined) v.trailer.buildBody = withGloss(v.trailer.buildBody, trailerGloss);
}

export const DEFAULT_VEHICLE_ID = bigfoot.id;

const byId = new Map(VEHICLES.map((v) => [v.id, v]));

/** Looks up a vehicle by id, falling back to the default if unknown/missing. */
export function getVehicle(id) {
  return byId.get(id) ?? byId.get(DEFAULT_VEHICLE_ID);
}

/** A board row's car name; null = a rally total driven in several cars. */
export const vehicleLabel = (id) => (id == null ? 'Mixed cars' : getVehicle(id).name);

/** Vehicles belonging to one category tab, in registry order. */
export function vehiclesInCategory(categoryId) {
  return VEHICLES.filter((v) => v.category === categoryId);
}
