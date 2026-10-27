// Rally cans in the boot: oil, fuel, coolant and brake fluid poured in at a field fix and refilled at a
// service (lib/serviceRepairs.js). Their mass rides with the fuel (car.js cargo).

export const CAN_L = { oilL: 5, fuelL: 5, coolantL: 5, brakeL: 1 };
export const SUPPLY_KEYS = ['oilL', 'fuelL', 'coolantL', 'brakeL'];
const KG_PER_L = { oilL: 0.88, fuelL: 0.75, coolantL: 1.05, brakeL: 1.05 };

export const emptySupplies = () => ({ oilL: 0, fuelL: 0, coolantL: 0, brakeL: 0 });
export const fullSupplies = () => ({ ...CAN_L });

export const suppliesKg = (s) => SUPPLY_KEYS.reduce((kg, key) => kg + s[key] * KG_PER_L[key], 0);

/** Saved / picked cans, each clamped to 0..its can (missing ones empty). */
export function readSupplies(state) {
  const s = emptySupplies();
  for (const key of SUPPLY_KEYS) if (Number.isFinite(state?.[key])) s[key] = Math.min(CAN_L[key], Math.max(0, state[key]));
  return s;
}
