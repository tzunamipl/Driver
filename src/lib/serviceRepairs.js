// Rally repair jobs: every part's condition and what can be done to it. At a service a Fix
// closes part of the damage (lib/partRepair.js tiers) and a Replace makes the part as new;
// times are virtual minutes against the zone's budget (ui/serviceDialog.js), a remote service
// crew only fixes. Anywhere else the crew can do a smaller field fix (and pour in the cans,
// lib/supplies.js), at FIELD_FIX_PENALTY_MS each on a live stage (app/rally/fieldRepair.js).

import { setShockHealth } from './shocks.js';
import { getTyreCompound } from './tyres/compounds.js';
import { repairPlan, applyRepair } from './partRepair.js';
import { SPARE_FIT_PENALTY_MS } from './spareTyres.js';
import { CAN_L, SUPPLY_KEYS, fullSupplies } from './supplies.js';
import { RESERVE_FRACTION } from './fuel.js';
import { formatVolume, formatTemp, volumeValue, volumeUnit } from './units.js';

export const SERVICE_ZONES = {
  service: { label: 'Service', budgetMin: 30, replace: true },
  remoteService: { label: 'Remote service', budgetMin: 15, replace: false },
};
// Late out of service: this per started minute over the budget.
export const LATE_PENALTY_MS_PER_MIN = 10_000;
export const FIELD_FIX_PENALTY_MS = 30_000;
// Rally clock minutes a field action takes (app/rally/rallyConditions.js).
const FIELD_FIX_MIN = 3;
const POUR_CAN_MIN = 2;
const SPARE_FIT_MIN = 5;

const TYRE_MIN = 4;
const SHOCK_FIX_MIN = 5;
const SHOCK_REPLACE_MIN = 10;
const RADIATOR_FIX_MIN = 4;
const RADIATOR_REPLACE_MIN = 12;
const SUMP_FIX_MIN = 4;
const SUMP_REPLACE_MIN = 10;
const ENGINE_REBUILD_MIN = 30;
const TOP_UP_MIN = 1;
const LAMP_TAPE_MIN = 1;
const LAMP_REPLACE_MIN = 3;
const GEARBOX_FIX_MIN = 10;
const GEARBOX_REPLACE_MIN = 25;
// A service adds at most this much fuel (refuel zones fill the tank).
const SERVICE_FUEL_L = 5;
const FIX_HINT = { fix: 'Fixes 40-60% of the damage, 20-40% of new damage after that', field: 'Fixes 10-30% of the damage, 5-15% of new damage after that' };

// Condition shown as OK from these (tread / health / levels); below the second as bad.
const GOOD = 0.95;
const POOR = 0.5;
const WORN_TREAD = 0.35; // the tyre service dialog's "Worn"
const BALD_TREAD = 0.05;
const LOW_FUEL = 0.125;
const SIDE_NAMES = ['left', 'right']; // lampDamage.js sides: 0 = +x (left)

export const latePenaltyMs = (usedMin, budgetMin) => Math.ceil(Math.max(0, usedMin - budgetMin)) * LATE_PENALTY_MS_PER_MIN;

const pct = (v) => `${Math.round(v * 100)}%`;
const litres = (v) => formatVolume(v);
const perMin = (lps, digits) => `${volumeValue(lps * 60).toFixed(digits)} ${volumeUnit()}/min`;
const verdictOf = (v) => (v >= GOOD ? 'good' : v >= POOR ? 'warn' : 'bad');
const repairNote = (record) => (record?.fixAt != null ? 'fixed' : record?.at != null ? 'field fixed' : '');

/**
 * Fix and field fix of a part with a health 0..1 and a partRepair.js record, while it is damaged.
 * part: { health(), setHealth(h), record(), setRecord(r) }.
 */
function tieredActions(part, { fixLabel = 'Fix', fieldLabel = 'Field fix', fixMin }) {
  const actions = [];
  for (const kind of ['fix', 'field']) {
    if (!repairPlan(kind, part.record(), part.health())) continue;
    const apply = () => {
      const done = applyRepair(kind, part.record(), part.health());
      if (!done) return;
      part.setHealth(done.health);
      part.setRecord(done.record);
    };
    actions.push(kind === 'fix' ? { kind, label: fixLabel, minutes: fixMin, remote: true, hint: FIX_HINT.fix, apply } : { kind, label: fieldLabel, penaltyMs: FIELD_FIX_PENALTY_MS, clockMin: FIELD_FIX_MIN, hint: FIX_HINT.field, apply });
  }
  return actions;
}

/** Pour what the can holds (up to the room left) into a tank: a field action, or null. */
function pourCan(vehicle, key, room, pour) {
  const can = vehicle.supplies?.[key] ?? 0;
  const add = Math.min(can, room);
  if (add < 0.05) return null;
  return {
    kind: 'field',
    label: 'Pour can',
    note: `${litres(add)} from the can`,
    penaltyMs: FIELD_FIX_PENALTY_MS,
    clockMin: POUR_CAN_MIN,
    apply: () => {
      pour(add);
      vehicle.setSupplies({ ...vehicle.supplies, [key]: can - add });
    },
  };
}

/**
 * Every part of the car, grouped for the dialog:
 * [{ group, label, level (0..1 bar) | null, note, verdict 'good' | 'warn' | 'bad' | '', anchor (app/partCallouts.js) | null,
 *    actions: [{ kind 'fix' | 'replace' | 'field', label, minutes (service), remote, penaltyMs + clockMin (field), note?, hint?, disabled?, apply }] }].
 */
export function carParts(vehicle) {
  const parts = [];
  const labels = vehicle.wheelLabels ?? [];
  const wheelName = (i) => labels[i] ?? `Wheel ${i + 1}`;
  const compound = getTyreCompound(vehicle.tyreSetup?.compound);
  const lo = compound.optimalTempC - compound.windowC;
  const hi = compound.optimalTempC + compound.windowC;

  vehicle.wheelInfos?.forEach((w, i) => {
    const temp = Number.isFinite(w.tempC) ? `${formatTemp(w.tempC)}${w.tempC < lo ? ' cold' : w.tempC > hi ? ' hot' : ''}` : '';
    const state = w.punctured ? 'Flat' : w.tread < BALD_TREAD ? 'Bald' : w.tread < WORN_TREAD ? 'Worn' : '';
    const actions = w.punctured || w.tread < GOOD ? [{ kind: 'replace', label: 'New tyre', minutes: TYRE_MIN, remote: true, apply: () => vehicle.repairTyres(i) }] : [];
    if (w.punctured && vehicle.fitSpareTyre) {
      const spares = vehicle.spareTyres ?? 0;
      actions.push({
        kind: 'field',
        label: spares ? 'Fit spare' : 'No spare wheel',
        note: spares ? `${spares} spare${spares > 1 ? 's' : ''} left` : '',
        penaltyMs: SPARE_FIT_PENALTY_MS,
        clockMin: SPARE_FIT_MIN,
        disabled: !spares,
        apply: () => vehicle.fitSpareTyre(i),
      });
    }
    parts.push({
      group: 'Tyres',
      label: wheelName(i),
      level: w.punctured ? 0 : w.tread,
      note: [state, `tread ${pct(w.tread)}`, temp].filter(Boolean).join(' · '),
      verdict: w.punctured || w.tread < BALD_TREAD ? 'bad' : w.tread < WORN_TREAD ? 'warn' : 'good',
      anchor: { wheel: i },
      actions,
    });
  });

  vehicle.wheelInfos?.forEach((w, i) => {
    const h = w.shockHealth;
    const shock = { health: () => w.shockHealth, setHealth: (v) => setShockHealth(w, v), record: () => w.shockRepair, setRecord: (r) => (w.shockRepair = r) };
    parts.push({
      group: 'Suspension',
      label: `Shock · ${wheelName(i)}`,
      level: h,
      note: [`health ${pct(h)}`, repairNote(w.shockRepair)].filter(Boolean).join(' · '),
      verdict: verdictOf(h),
      anchor: { shock: i },
      actions: h < GOOD ? [...tieredActions(shock, { fixMin: SHOCK_FIX_MIN }), { kind: 'replace', label: 'New shock', minutes: SHOCK_REPLACE_MIN, remote: false, apply: () => vehicle.repairShocks(i) }] : [],
    });
  });

  const heat = vehicle.heat;
  if (heat) {
    const leaking = heat.leakLps > 0;
    const radiator = { health: () => heat.radiatorHealth, setHealth: (v) => (heat.radiatorHealth = v), record: () => heat.radiatorRepair, setRecord: (r) => (heat.radiatorRepair = r) };
    parts.push({
      group: 'Cooling',
      label: 'Radiator',
      level: null,
      note: [leaking ? `leaking ${perMin(heat.leakLps, 1)}` : 'sealed', repairNote(heat.radiatorRepair)].filter(Boolean).join(' · '),
      verdict: leaking ? 'bad' : 'good',
      anchor: 'front',
      actions: leaking
        ? [...tieredActions(radiator, { fixLabel: 'Patch', fieldLabel: 'Patch', fixMin: RADIATOR_FIX_MIN }), { kind: 'replace', label: 'New radiator', minutes: RADIATOR_REPLACE_MIN, remote: false, apply: () => heat.repairRadiator() }]
        : [],
    });
    const coolantRoom = heat.capacityL - heat.coolantL;
    parts.push({
      group: 'Cooling',
      label: 'Coolant',
      level: heat.level,
      note: `${pct(heat.level)} · ${formatTemp(heat.coolantTempC)}`,
      verdict: verdictOf(heat.level),
      anchor: 'front',
      actions:
        heat.level < GOOD
          ? [{ kind: 'fix', label: 'Top up', minutes: TOP_UP_MIN, remote: true, apply: () => (heat.coolantL = heat.capacityL) }, pourCan(vehicle, 'coolantL', coolantRoom, (l) => (heat.coolantL += l))].filter(Boolean)
          : [],
    });

    const oilRoom = heat.oilCapacityL - heat.oilL;
    parts.push({
      group: 'Engine',
      label: 'Oil',
      level: heat.oilLevel,
      note: `${litres(heat.oilL)} · ${formatTemp(heat.oilTempC)}`,
      verdict: heat.oilWarning ? 'bad' : verdictOf(heat.oilLevel),
      anchor: 'engine',
      actions:
        heat.oilLevel < GOOD
          ? [{ kind: 'fix', label: 'Top up', minutes: TOP_UP_MIN, remote: true, apply: () => (heat.oilL = heat.oilCapacityL) }, pourCan(vehicle, 'oilL', oilRoom, (l) => (heat.oilL += l))].filter(Boolean)
          : [],
    });
    const sumpLeaking = heat.oilLeakLps > 0;
    const sump = { health: () => heat.sumpHealth, setHealth: (v) => (heat.sumpHealth = v), record: () => heat.sumpRepair, setRecord: (r) => (heat.sumpRepair = r) };
    parts.push({
      group: 'Engine',
      label: 'Sump',
      level: null,
      note: [sumpLeaking ? `leaking ${perMin(heat.oilLeakLps, 2)}` : 'sealed', repairNote(heat.sumpRepair)].filter(Boolean).join(' · '),
      verdict: sumpLeaking ? 'bad' : 'good',
      anchor: 'under',
      actions: sumpLeaking
        ? [...tieredActions(sump, { fixLabel: 'Patch', fieldLabel: 'Patch', fixMin: SUMP_FIX_MIN }), { kind: 'replace', label: 'New sump', minutes: SUMP_REPLACE_MIN, remote: false, apply: () => heat.repairSump() }]
        : [],
    });
    if (heat.engineHealth < 1) {
      parts.push({
        group: 'Engine',
        label: 'Bearings',
        level: heat.engineHealth,
        note: `worn by low oil pressure · ${pct(heat.engineHealth)}`,
        verdict: verdictOf(heat.engineHealth),
        anchor: 'engine',
        actions: heat.engineHealth < GOOD ? [{ kind: 'replace', label: 'Rebuild engine', minutes: ENGINE_REBUILD_MIN, remote: false, apply: () => heat.repairEngine() }] : [],
      });
    }
    if (heat.powerFactor < 1) parts.push({ group: 'Engine', label: 'Power', level: heat.powerFactor, note: `limp mode · ${pct(heat.powerFactor)}`, verdict: 'bad', anchor: null, actions: [] });
  }

  const lamps = vehicle.lamps;
  if (lamps) {
    for (const kind of ['head', 'tail']) {
      lamps.broken[kind].forEach((broken, side) => {
        const taped = lamps.taped?.[kind][side];
        const tape = () => lamps.tape(kind, side);
        parts.push({
          group: 'Lamps',
          label: `${kind === 'head' ? 'Head' : 'Tail'} lamp · ${SIDE_NAMES[side]}`,
          level: null,
          note: broken ? 'broken' : taped ? 'taped up' : 'working',
          verdict: broken ? 'bad' : taped ? 'warn' : 'good',
          anchor: { lamp: kind, side },
          actions: [
            ...(broken ? [{ kind: 'fix', label: 'Tape up', minutes: LAMP_TAPE_MIN, remote: true, apply: tape }, { kind: 'field', label: 'Tape up', penaltyMs: FIELD_FIX_PENALTY_MS, clockMin: FIELD_FIX_MIN, apply: tape }] : []),
            ...(broken || taped ? [{ kind: 'replace', label: 'New lamp', minutes: LAMP_REPLACE_MIN, remote: false, apply: () => lamps.repair(kind, side) }] : []),
          ],
        });
      });
    }
  }

  const gearbox = vehicle.engine?.gearbox;
  if (gearbox) {
    const h = gearbox.health;
    const box = { health: () => gearbox.health, setHealth: (v) => gearbox.setState(v), record: () => gearbox.repairRecord, setRecord: (r) => (gearbox.repairRecord = r) };
    parts.push({
      group: 'Drivetrain',
      label: 'Gearbox',
      level: h,
      note: [`health ${pct(h)}`, h < GOOD ? `shifts ${gearbox.shiftFactor.toFixed(1)}x slower` : '', repairNote(gearbox.repairRecord)].filter(Boolean).join(' · '),
      verdict: verdictOf(h),
      anchor: 'under',
      actions: h < GOOD ? [...tieredActions(box, { fixMin: GEARBOX_FIX_MIN }), { kind: 'replace', label: 'New gearbox', minutes: GEARBOX_REPLACE_MIN, remote: false, apply: () => gearbox.repair() }] : [],
    });
  }

  const fuel = vehicle.fuel;
  if (fuel) {
    const room = fuel.capacityL - fuel.litres;
    const add = Math.min(SERVICE_FUEL_L, room);
    parts.push({
      group: 'Fuel & spares',
      label: 'Tank',
      level: fuel.fraction,
      note: `${volumeValue(fuel.litres).toFixed(1)} / ${Math.round(volumeValue(fuel.capacityL))} ${volumeUnit()}`,
      verdict: fuel.fraction < LOW_FUEL ? 'bad' : 'good',
      anchor: 'filler',
      actions: [
        ...(add >= 0.5 ? [{ kind: 'fix', label: `Add ${formatVolume(add, 0)}`, minutes: TOP_UP_MIN, remote: true, apply: () => fuel.setLitres(fuel.litres + add) }] : []),
        ...(fuel.fraction < RESERVE_FRACTION ? [pourCan(vehicle, 'fuelL', room, (l) => fuel.setLitres(fuel.litres + l))].filter(Boolean) : []),
      ],
    });
  }
  if (vehicle.supplies) {
    const s = vehicle.supplies;
    const total = SUPPLY_KEYS.reduce((sum, key) => sum + s[key], 0);
    const full = SUPPLY_KEYS.length * CAN_L;
    parts.push({
      group: 'Fuel & spares',
      label: 'Cans',
      level: total / full,
      note: `oil ${volumeValue(s.oilL).toFixed(1)} · fuel ${volumeValue(s.fuelL).toFixed(1)} · coolant ${volumeValue(s.coolantL).toFixed(1)} ${volumeUnit()}`,
      verdict: '',
      anchor: null,
      actions: total < full - 0.05 ? [{ kind: 'fix', label: 'Refill', minutes: TOP_UP_MIN, remote: true, apply: () => vehicle.setSupplies(fullSupplies()) }] : [],
    });
  }
  if (Number.isFinite(vehicle.spareTyres)) {
    parts.push({ group: 'Fuel & spares', label: 'Spare wheels', level: null, note: String(vehicle.spareTyres), verdict: '', anchor: null, actions: [] });
  }
  return parts;
}
