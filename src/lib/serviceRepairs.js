// Rally service jobs: every part's condition and what a crew can do to it. A Fix is quicker
// but only part of the way back; a Replace is as new. Times are virtual minutes against the
// zone's budget (ui/serviceDialog.js); a remote service crew only fixes (plus tyres, lamps, coolant).

import { setShockHealth } from './shocks.js';
import { getTyreCompound } from './tyres/compounds.js';

export const SERVICE_ZONES = {
  service: { label: 'Service', budgetMin: 30, replace: true },
  remoteService: { label: 'Remote service', budgetMin: 15, replace: false },
};
// Late out of service: this per started minute over the budget.
export const LATE_PENALTY_MS_PER_MIN = 10_000;

const TYRE_MIN = 4;
const SHOCK_FIX_MIN = 5;
const SHOCK_REPLACE_MIN = 10;
const SHOCK_FIX_SHARE = 0.6; // of the lost health
const RADIATOR_FIX_MIN = 4;
const RADIATOR_REPLACE_MIN = 12;
const RADIATOR_FIX_LEAK_LEFT = 0.2;
const COOLANT_MIN = 1;
const LAMP_TAPE_MIN = 1;
const LAMP_REPLACE_MIN = 3;
const GEARBOX_FIX_MIN = 10;
const GEARBOX_REPLACE_MIN = 25;
const GEARBOX_FIX_SHARE = 0.5;

// Condition shown as OK from these (tread / health / coolant level); below the second as bad.
const GOOD = 0.95;
const POOR = 0.5;
const WORN_TREAD = 0.35; // the tyre service dialog's "Worn"
const BALD_TREAD = 0.05;
const LOW_FUEL = 0.125;
const SIDE_NAMES = ['left', 'right']; // lampDamage.js sides: 0 = +x (left)

export const latePenaltyMs = (usedMin, budgetMin) => Math.ceil(Math.max(0, usedMin - budgetMin)) * LATE_PENALTY_MS_PER_MIN;

const pct = (v) => `${Math.round(v * 100)}%`;
const verdictOf = (v) => (v >= GOOD ? 'good' : v >= POOR ? 'warn' : 'bad');

/**
 * Every part of the car, grouped for the dialog:
 * [{ group, label, level (0..1 bar) | null, note, verdict 'good' | 'warn' | 'bad' | '', actions: [{ kind 'fix' | 'replace', label, minutes, remote, apply }] }].
 */
export function carParts(vehicle) {
  const parts = [];
  const labels = vehicle.wheelLabels ?? [];
  const wheelName = (i) => labels[i] ?? `Wheel ${i + 1}`;
  const compound = getTyreCompound(vehicle.tyreSetup?.compound);
  const lo = compound.optimalTempC - compound.windowC;
  const hi = compound.optimalTempC + compound.windowC;

  vehicle.wheelInfos?.forEach((w, i) => {
    const temp = Number.isFinite(w.tempC) ? `${Math.round(w.tempC)} °C${w.tempC < lo ? ' cold' : w.tempC > hi ? ' hot' : ''}` : '';
    const state = w.punctured ? 'Flat' : w.tread < BALD_TREAD ? 'Bald' : w.tread < WORN_TREAD ? 'Worn' : '';
    parts.push({
      group: 'Tyres',
      label: wheelName(i),
      level: w.punctured ? 0 : w.tread,
      note: [state, `tread ${pct(w.tread)}`, temp].filter(Boolean).join(' · '),
      verdict: w.punctured || w.tread < BALD_TREAD ? 'bad' : w.tread < WORN_TREAD ? 'warn' : 'good',
      actions: w.punctured || w.tread < GOOD ? [{ kind: 'replace', label: 'New tyre', minutes: TYRE_MIN, remote: true, apply: () => vehicle.repairTyres(i) }] : [],
    });
  });

  vehicle.wheelInfos?.forEach((w, i) => {
    const h = w.shockHealth;
    const damaged = h < GOOD;
    parts.push({
      group: 'Suspension',
      label: `Shock · ${wheelName(i)}`,
      level: h,
      note: `health ${pct(h)}`,
      verdict: verdictOf(h),
      actions: damaged
        ? [
            { kind: 'fix', label: 'Fix', minutes: SHOCK_FIX_MIN, remote: true, apply: () => setShockHealth(w, w.shockHealth + (1 - w.shockHealth) * SHOCK_FIX_SHARE) },
            { kind: 'replace', label: 'New shock', minutes: SHOCK_REPLACE_MIN, remote: false, apply: () => vehicle.repairShocks(i) },
          ]
        : [],
    });
  });

  const heat = vehicle.heat;
  if (heat) {
    const leaking = heat.leakLps > 0;
    const topUp = () => (heat.coolantL = heat.capacityL);
    parts.push({
      group: 'Cooling',
      label: 'Radiator',
      level: null,
      note: leaking ? `leaking ${(heat.leakLps * 60).toFixed(1)} L/min` : 'sealed',
      verdict: leaking ? 'bad' : 'good',
      actions: leaking
        ? [
            { kind: 'fix', label: 'Patch', minutes: RADIATOR_FIX_MIN, remote: true, apply: () => { heat.leakLps *= RADIATOR_FIX_LEAK_LEFT; topUp(); } },
            { kind: 'replace', label: 'New radiator', minutes: RADIATOR_REPLACE_MIN, remote: false, apply: () => heat.repair() },
          ]
        : [],
    });
    parts.push({
      group: 'Cooling',
      label: 'Coolant',
      level: heat.level,
      note: `${pct(heat.level)} · ${Math.round(heat.coolantTempC)} °C`,
      verdict: verdictOf(heat.level),
      actions: heat.level < GOOD ? [{ kind: 'fix', label: 'Top up', minutes: COOLANT_MIN, remote: true, apply: topUp }] : [],
    });
    parts.push({ group: 'Engine', label: 'Oil', level: null, note: `${Math.round(heat.oilTempC)} °C`, verdict: '', actions: [] });
    if (heat.powerFactor < 1) parts.push({ group: 'Engine', label: 'Power', level: heat.powerFactor, note: `limp mode · ${pct(heat.powerFactor)}`, verdict: 'bad', actions: [] });
  }

  const lamps = vehicle.lamps;
  if (lamps) {
    for (const kind of ['head', 'tail']) {
      lamps.broken[kind].forEach((broken, side) => {
        const taped = lamps.taped?.[kind][side];
        parts.push({
          group: 'Lamps',
          label: `${kind === 'head' ? 'Head' : 'Tail'} lamp · ${SIDE_NAMES[side]}`,
          level: null,
          note: broken ? 'broken' : taped ? 'taped up' : 'working',
          verdict: broken ? 'bad' : taped ? 'warn' : 'good',
          actions: [
            ...(broken ? [{ kind: 'fix', label: 'Tape up', minutes: LAMP_TAPE_MIN, remote: true, apply: () => lamps.tape(kind, side) }] : []),
            ...(broken || taped ? [{ kind: 'replace', label: 'New lamp', minutes: LAMP_REPLACE_MIN, remote: false, apply: () => lamps.repair(kind, side) }] : []),
          ],
        });
      });
    }
  }

  const gearbox = vehicle.engine?.gearbox;
  if (gearbox) {
    const h = gearbox.health;
    parts.push({
      group: 'Drivetrain',
      label: 'Gearbox',
      level: h,
      note: `health ${pct(h)}${h < GOOD ? ` · shifts ${gearbox.shiftFactor.toFixed(1)}x slower` : ''}`,
      verdict: verdictOf(h),
      actions:
        h < GOOD
          ? [
              { kind: 'fix', label: 'Fix', minutes: GEARBOX_FIX_MIN, remote: true, apply: () => gearbox.setState(gearbox.health + (1 - gearbox.health) * GEARBOX_FIX_SHARE) },
              { kind: 'replace', label: 'New gearbox', minutes: GEARBOX_REPLACE_MIN, remote: false, apply: () => gearbox.repair() },
            ]
          : [],
    });
  }

  const fuel = vehicle.fuel;
  if (fuel) {
    parts.push({
      group: 'Fuel & spares',
      label: 'Tank',
      level: fuel.fraction,
      note: `${fuel.litres.toFixed(1)} / ${Math.round(fuel.capacityL)} L`,
      verdict: fuel.fraction < LOW_FUEL ? 'bad' : 'good',
      actions: [],
    });
  }
  if (Number.isFinite(vehicle.spareTyres)) {
    parts.push({ group: 'Fuel & spares', label: 'Spare wheels', level: null, note: String(vehicle.spareTyres), verdict: '', actions: [] });
  }
  return parts;
}
