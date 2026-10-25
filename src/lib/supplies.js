// Rally cans in the boot: oil, fuel and coolant poured in at a field fix and refilled at a
// service (lib/serviceRepairs.js). Their mass rides with the fuel (car.js cargo).

export const CAN_L = 5;
export const SUPPLY_KEYS = ['oilL', 'fuelL', 'coolantL'];
const KG_PER_L = { oilL: 0.88, fuelL: 0.75, coolantL: 1.05 };

export const emptySupplies = () => ({ oilL: 0, fuelL: 0, coolantL: 0 });
export const fullSupplies = () => ({ oilL: CAN_L, fuelL: CAN_L, coolantL: CAN_L });

export const suppliesKg = (s) => SUPPLY_KEYS.reduce((kg, key) => kg + s[key] * KG_PER_L[key], 0);

/** Saved / picked cans, each clamped to 0..CAN_L (missing ones empty). */
export function readSupplies(state) {
  const s = emptySupplies();
  for (const key of SUPPLY_KEYS) if (Number.isFinite(state?.[key])) s[key] = Math.min(CAN_L, Math.max(0, state[key]));
  return s;
}
