// Free roam: with the car nearly stopped, a floating button points at each damaged part
// (flat or worn tyre, worn shock, leaking radiator / low coolant, cracked sump / low oil, worn engine,
// broken lamp, worn gearbox, fuel on reserve) and fixes that part on a click (app/partCallouts.js).
// Resets and teleports don't fix the car.

import { createPartCallouts } from './partCallouts.js';
import { RESERVE_FRACTION } from '../lib/fuel.js';
import { formatVolume } from '../lib/units.js';

// Tread below this offers a fresh tyre (the tyre service dialog's "Worn").
const WORN_TREAD = 0.35;
// Shock / gearbox health and coolant / oil level below these offer a fix.
const WORN_SHOCK = 0.95;
const WORN_GEARBOX = 0.95;
const WORN_ENGINE = 0.95;
const LOW_COOLANT = 0.95;
const LOW_OIL = 0.95;
const SIDE_NAMES = ['left', 'right']; // lampDamage.js sides: 0 = +x (left)

const pct = (v) => `${Math.round(v * 100)}%`;

/** Every damaged part: { label, note, anchor, fix }. */
function damagedParts(vehicle) {
  const parts = [];
  const labels = vehicle.wheelLabels ?? [];
  vehicle.wheelInfos.forEach((w, i) => {
    const at = labels[i] ? ` · ${labels[i]}` : '';
    if (w.punctured || w.tread < WORN_TREAD) {
      parts.push({ label: `Replace tyre${at}`, note: w.punctured ? 'Flat' : `Worn · tread ${pct(w.tread)}`, anchor: { wheel: i }, fix: () => vehicle.repairTyres(i) });
    }
    if (w.shockHealth < WORN_SHOCK) {
      parts.push({ label: `Replace shock${at}`, note: `Health ${pct(w.shockHealth)}`, anchor: { shock: i }, fix: () => vehicle.repairShocks(i) });
    }
  });
  const heat = vehicle.heat;
  if (heat && (heat.leakLps > 0 || heat.level < LOW_COOLANT)) {
    const leaking = heat.leakLps > 0;
    parts.push({ label: leaking ? 'Fix radiator' : 'Top up coolant', note: `${leaking ? 'Leaking · ' : ''}coolant ${pct(heat.level)}`, anchor: 'front', fix: () => heat.repairRadiator() });
  }
  if (heat && (heat.oilLeakLps > 0 || heat.oilLevel < LOW_OIL)) {
    const leaking = heat.oilLeakLps > 0;
    parts.push({ label: leaking ? 'Fix sump' : 'Top up oil', note: `${leaking ? 'Leaking · ' : ''}oil ${pct(heat.oilLevel)}`, anchor: leaking ? 'under' : 'engine', fix: () => heat.repairSump() });
  }
  if (heat && heat.engineHealth < WORN_ENGINE) {
    parts.push({ label: 'Rebuild engine', note: `Worn by low oil pressure · ${pct(heat.engineHealth)}`, anchor: 'engine', fix: () => heat.repairEngine() });
  }
  const fuel = vehicle.fuel;
  if (fuel && fuel.fraction < RESERVE_FRACTION) {
    parts.push({ label: 'Refuel', note: fuel.litres > 0 ? `Low · ${formatVolume(fuel.litres)}` : 'Empty', anchor: 'filler', fix: () => fuel.setLitres(fuel.capacityL) });
  }
  const lamps = vehicle.lamps;
  for (const kind of ['head', 'tail']) {
    lamps?.broken[kind].forEach((broken, side) => {
      if (broken) parts.push({ label: `Replace ${kind} lamp · ${SIDE_NAMES[side]}`, note: 'Broken', anchor: { lamp: kind, side }, fix: () => lamps.repair(kind, side) });
    });
  }
  const gearbox = vehicle.engine?.gearbox;
  if (gearbox && gearbox.health < WORN_GEARBOX) {
    parts.push({ label: 'Fix gearbox', note: `Health ${pct(gearbox.health)}`, anchor: 'under', fix: () => gearbox.repair() });
  }
  return parts;
}

/**
 * @param {object} deps
 * @param {HTMLCanvasElement} deps.canvas
 * @param {THREE.Camera} deps.camera
 * @param {() => object | null} deps.getVehicle
 * @param {() => void} [deps.onRepair] - sound when a part is fixed.
 */
export function createRoadsideRepair({ canvas, camera, getVehicle, onRepair }) {
  const callouts = createPartCallouts({ canvas, camera });

  /** Per frame, after the camera moved. */
  function update() {
    const vehicle = getVehicle();
    callouts.update(vehicle?.lamps ? vehicle : null, (v) =>
      damagedParts(v).map((part) => ({ ...part, onClick: () => { part.fix(); onRepair?.(); } }))
    );
  }

  return { update };
}
