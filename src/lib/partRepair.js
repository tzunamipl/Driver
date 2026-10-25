// Partial repairs of a part's health (1 new .. 0 wrecked). A service Fix closes a random
// share of the gap to new, a field fix (roadside, rally) a smaller one. Once repaired, the
// next repair of that kind only works on damage taken since: a Fix on what's new since the
// last Fix, a field fix on what's new since the last repair of any kind (so never over a
// Fix). A Fix ignores earlier field fixes (they don't stack) and starts from the health
// they had patched over. Replace (the part's own repair()) clears the record.
//   record: { fixAt: health after the last Fix | null, at: after the last repair, fieldGain: health added by field fixes since }

const SHARES = {
  fix: { first: [0.4, 0.6], again: [0.2, 0.4] },
  field: { first: [0.1, 0.3], again: [0.05, 0.15] },
};
// Less damage than this to work on isn't worth a repair.
const MIN_GAP = 0.01;

/** What a 'fix' / 'field' repair would work on: { from, to, range }, or null when there is nothing for it. */
export function repairPlan(kind, record, health) {
  const again = kind === 'fix' ? record?.fixAt != null : record?.at != null;
  const from = kind === 'fix' ? Math.max(0, health - (record?.fieldGain ?? 0)) : health;
  const to = (kind === 'fix' ? record?.fixAt : record?.at) ?? 1;
  if (to - from < MIN_GAP) return null;
  return { from, to, range: SHARES[kind][again ? 'again' : 'first'] };
}

/** Rolls the repair: { health, record } (null when the plan has nothing to do). */
export function applyRepair(kind, record, health, roll = Math.random()) {
  const plan = repairPlan(kind, record, health);
  if (!plan) return null;
  const [lo, hi] = plan.range;
  const after = Math.min(1, Math.max(health, plan.from + (plan.to - plan.from) * (lo + (hi - lo) * roll)));
  if (kind === 'fix') return { health: after, record: { fixAt: after, at: after, fieldGain: 0 } };
  return { health: after, record: { fixAt: record?.fixAt ?? null, at: after, fieldGain: (record?.fieldGain ?? 0) + after - health } };
}

/** A saved record, or null when it doesn't look like one. */
export function readRepairRecord(state) {
  if (!state || !Number.isFinite(state.at)) return null;
  return { fixAt: Number.isFinite(state.fixAt) ? state.fixAt : null, at: state.at, fieldGain: Number.isFinite(state.fieldGain) ? state.fieldGain : 0 };
}
