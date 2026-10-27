// Vehicle registry: collects every vehicle descriptor (one per file, see
// ./kairoS.js for the shape each must export) into a single list, grouped
// under a fixed set of category tabs for the lobby's vehicle picker (see
// ui/lobby.js). Adding a new vehicle later is just a new file + one more
// entry in VEHICLES below + its display name in ./names.js - lib/car.js's
// shared rig and the picker UI both pick it up automatically.

import kairoS from './kairoS.js';
import kairoWagon from './kairoWagon.js';
import kairoWagonMk2 from './kairoWagonMk2.js';
import chariotOfFire from './chariotOfFire.js';
import bigfoot from './bigfoot.js';
import speeder from './speeder.js';
import rally from './rally.js'
import attackerRS from './attackerRS.js';
import htv from './htv.js';
import deathTanker from './deathTanker.js';
import kairoR from './kairoR.js';
import stallionTurbo from './stallionTurbo.js';
import { setPaintGloss } from './geometry/paint.js';
import { VEHICLE_NAMES } from './names.js';
import { currentVehicleId } from './legacyIds.js';
import uranus from './uranus.js';
import samson from './samson.js';
import v8Eagle from './v8Eagle.js';
import peacemaker from './peacemaker.js';
import klikKlak from './klikKlak.js';
import halny from './halny.js';
import president from './president.js';
import zx2 from './zx2.js';
import seagul from './seagul.js';
import explorer from './explorer.js';
import spring from './spring.js';
import attacker from './attacker.js';
import stallion from './stallion.js';
import halnyR from './halnyR.js';
import superCar from './super.js';
import muscle from './muscle.js';
import malaise from './malaise.js';
import urban from './urban.js';
import worker from './worker.js';
import majster from './majster.js';
import hummel from './hummel.js';
import sheriff from './sheriff.js';
import kostka from './kostka.js';


// Fixed set of tabs shown in the lobby's vehicle picker, in display order.
// `id` is what's actually stored/selected; `label` is only for display.
export const CATEGORIES = [
  { id: 'cars', label: 'Cars' },
  { id: 'rally', label: 'Rally' },
  { id: 'trucks', label: 'Trucks' },
  { id: 'postapo', label: 'Postapo' },
  { id: 'dumb', label: 'Dumb' },
];

// Every selectable vehicle, regardless of category - add new ones here
// once their own file exists. Empty categories are still shown as tabs
// with an empty list (see CATEGORIES above).
export const VEHICLES = [kairoS, kairoWagon, kairoWagonMk2, klikKlak, halny, stallion, attacker, president, zx2, seagul, muscle, malaise, kostka, urban, majster, superCar, explorer, sheriff, chariotOfFire, bigfoot, speeder, rally, spring, worker, attackerRS, kairoR, stallionTurbo, halnyR, hummel, htv, samson, uranus, deathTanker, peacemaker, v8Eagle];

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
  v.name = VEHICLE_NAMES[v.id] ?? v.id;
  v.buildBody = withFlatShading(v.buildBody);
  if (v.trailer) v.trailer.buildBody = withFlatShading(v.trailer.buildBody);
  if (v.gloss !== undefined) v.buildBody = withGloss(v.buildBody, v.gloss);
  const trailerGloss = v.trailer?.gloss ?? v.gloss;
  if (v.trailer && trailerGloss !== undefined) v.trailer.buildBody = withGloss(v.trailer.buildBody, trailerGloss);
}

export const DEFAULT_VEHICLE_ID = bigfoot.id;

const byId = new Map(VEHICLES.map((v) => [v.id, v]));

/** Looks up a vehicle by id (legacy ids too), falling back to the default if unknown/missing. */
export function getVehicle(id) {
  return byId.get(id) ?? byId.get(currentVehicleId(id)) ?? byId.get(DEFAULT_VEHICLE_ID);
}

/** A board row's car name; null = a rally total driven in several cars. */
export const vehicleLabel = (id) => (id == null ? 'Mixed cars' : getVehicle(id).name);

/** Vehicles belonging to one category tab, alphabetically by display name. */
export function vehiclesInCategory(categoryId) {
  return VEHICLES.filter((v) => v.category === categoryId).sort((a, b) => a.name.localeCompare(b.name));
}
