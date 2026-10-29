// Free roam: with the car nearly stopped, a floating button points at each damaged part
// (flat or worn tyre, broken rim, worn shock, worn brake disc / drum, leaking brake pipe / low brake fluid, leaking radiator / low coolant,
// worn skid plate, cracked sump / low oil, worn engine, broken lamp, worn gearbox, loose or lost exhaust, scratched paint, fuel on reserve) and fixes that part on a click (app/partCallouts.js).
// With two or more, a big Fix all button fixes everything at once. Resets and teleports don't fix the car.

import { createPartCallouts } from './partCallouts.js';
import { RESERVE_FRACTION } from '../lib/fuel.js';
import { formatVolume } from '../lib/units.js';
import { paintNote } from '../lib/serviceRepairs.js';

// Tread below this offers a fresh tyre (the tyre service dialog's "Worn").
const WORN_TREAD = 0.35;
// Shock / gearbox health and coolant / oil level below these offer a fix.
const WORN_SHOCK = 0.95;
const WORN_GEARBOX = 0.95;
const WORN_EXHAUST = 0.95;
const WARM_ENGINE_C = 100; // coolant above this reads as overheating in the engine's note
const LOW_COOLANT = 0.95;
const LOW_OIL = 0.95;
const WORN_SKID_PLATE = 0.95;
const WORN_BRAKE = 0.95;
const LOW_BRAKE_FLUID = 0.95;
const SIDE_NAMES = ['left', 'right']; // lampDamage.js sides: 0 = +x (left)

const pct = (v) => `${Math.round(v * 100)}%`;

/** Every damaged part: { label, note, anchor, fix }. */
function damagedParts(vehicle) {
  const parts = [];
  const labels = vehicle.wheelLabels ?? [];
  vehicle.wheelInfos.forEach((w, i) => {
    const at = labels[i] ? ` · ${labels[i]}` : '';
    if (w.punctured || w.rimBroken || w.tread < WORN_TREAD) {
      const note = [w.rimBroken ? 'Broken rim' : '', w.punctured ? 'Flat' : w.tread < WORN_TREAD ? `Worn · tread ${pct(w.tread)}` : ''].filter(Boolean).join(' · ');
      parts.push({ label: `Replace ${w.rimBroken ? 'wheel' : 'tyre'}${at}`, note, anchor: { wheel: i }, fix: () => vehicle.repairTyres(i) });
    }
    if (w.shockHealth < WORN_SHOCK) {
      parts.push({ label: `Replace shock${at}`, note: `Health ${pct(w.shockHealth)}`, anchor: { shock: i }, fix: () => vehicle.repairShocks(i) });
    }
  });
  const brakes = vehicle.brakes;
  brakes?.discs.forEach((d, i) => {
    if (d.health >= WORN_BRAKE) return;
    const at = labels[i] ? ` · ${labels[i]}` : '';
    parts.push({ label: `Replace brake ${d.type}${at}`, note: `Health ${pct(d.health)}`, anchor: { wheel: i }, fix: () => brakes.repairDisc(i) });
  });
  for (const key of ['front', 'rear']) {
    if (brakes?.circuits[key].leakLps > 0) {
      parts.push({ label: `Fix brake pipe · ${key}`, note: `Leaking · fluid ${pct(brakes.level)}`, anchor: { circuit: key }, fix: () => brakes.repairPipe(key) });
    }
  }
  if (brakes && brakes.level < LOW_BRAKE_FLUID && !Object.values(brakes.circuits).some((c) => c.leakLps > 0)) {
    parts.push({ label: 'Top up brake fluid', note: `Fluid ${pct(brakes.level)}`, anchor: 'engine', fix: () => (brakes.fluidL = brakes.capacityL) });
  }
  const heat = vehicle.heat;
  if (heat && (heat.leakLps > 0 || heat.level < LOW_COOLANT)) {
    const leaking = heat.leakLps > 0;
    parts.push({ label: leaking ? 'Fix radiator' : 'Top up coolant', note: `${leaking ? 'Leaking · ' : ''}coolant ${pct(heat.level)}`, anchor: 'front', fix: () => heat.repairRadiator() });
  }
  if (heat && (heat.oilLeakLps > 0 || heat.oilLevel < LOW_OIL)) {
    const leaking = heat.oilLeakLps > 0;
    parts.push({ label: leaking ? 'Fix sump' : 'Top up oil', note: `${leaking ? 'Leaking · ' : ''}oil ${pct(heat.oilLevel)}`, anchor: leaking ? 'under' : 'engine', fix: () => heat.repairSump() });
  }
  if (heat?.hasSkidPlate && heat.skidPlateHealth < WORN_SKID_PLATE) {
    parts.push({ label: 'Replace skid plate', note: `Health ${pct(heat.skidPlateHealth)}`, anchor: 'under', fix: () => heat.repairSkidPlate() });
  }
  // Whenever the check-engine lamp is on (warningLamps.js): worn or overheating.
  if (heat && heat.powerFactor < 1) {
    const worn = heat.engineHealth < 1;
    const note = [worn ? `Worn · ${pct(heat.engineHealth)}` : '', heat.coolantTempC > WARM_ENGINE_C ? 'Overheating' : '', `power ${pct(heat.powerFactor)}`].filter(Boolean).join(' · ');
    parts.push({ label: worn ? 'Rebuild engine' : 'Cool engine', note, anchor: 'engine', fix: () => { heat.repairEngine(); heat.coolDown(); } });
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
  const exhaust = vehicle.exhaust;
  if (exhaust && exhaust.health < WORN_EXHAUST) {
    parts.push({ label: 'Replace exhaust', note: exhaust.detached ? 'Fell off · power -20%' : `Health ${pct(exhaust.health)}`, anchor: 'exhaust', fix: () => exhaust.repair() });
  }
  const scratches = vehicle.bodyScratches;
  if (scratches?.patches.length) {
    const at = scratches.anchor();
    parts.push({ label: 'Respray body', note: paintNote(scratches), anchor: at ? { local: at } : 'front', fix: () => scratches.repair() });
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
  const fixAll = document.getElementById('repair-fix-all');
  let parts = []; // the callouts' parts this frame (none while driving)
  fixAll.addEventListener('click', () => {
    fixAll.blur();
    if (!parts.length) return;
    for (const part of parts) part.fix();
    onRepair?.();
  });

  /** Per frame, after the camera moved. */
  function update() {
    const vehicle = getVehicle();
    parts = [];
    callouts.update(vehicle?.lamps ? vehicle : null, (v) => {
      parts = damagedParts(v);
      return parts.map((part) => ({ ...part, onClick: () => { part.fix(); onRepair?.(); } }));
    });
    fixAll.hidden = parts.length < 2;
    const label = `Fix all (${parts.length})`;
    if (!fixAll.hidden && fixAll.textContent !== label) fixAll.textContent = label;
  }

  return { update };
}
