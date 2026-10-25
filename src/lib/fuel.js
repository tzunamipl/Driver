// Fuel tank for engine cars: on throttle it burns by the engine's brake power
// (rated hp x engine.loadFraction) through a specific fuel consumption, plus a
// running loss that grows with rpm, both scaled by engine.throttle. Off throttle
// the injectors cut to the idle flow. The fuel's mass rides on the chassis body
// on top of the descriptor's dry mass, with any cargo (spare wheels). Empty refills
// to full unless `refillWhenEmpty` is off; then it stays dry (car.js cuts the power).

const W_PER_HP = 745.7;
const FUELS = {
  // density kg/L, brake specific fuel consumption g/kWh
  petrol: { density: 0.745, bsfc: 250 },
  diesel: { density: 0.832, bsfc: 210 },
};
const DEFAULT_FUEL_TYPE = 'petrol';
const DEFAULT_TANK_L = 50;
// Idle flow (L/h) per rated kW when the descriptor sets no idleFuelLph.
const IDLE_FUEL_LPH_PER_KW = 0.008;
// Mass is re-applied once the fuel changed by this much (kg).
const MASS_UPDATE_KG = 0.5;
// Average consumption window, in one-second buckets.
const AVERAGE_WINDOW_S = 60;

/** Tank for a wheeled engine descriptor; `chassisBody` gets the fuel's mass. */
export function createFuelTank(descriptor, chassisBody) {
  const fuel = FUELS[descriptor.fuelType] ?? FUELS[DEFAULT_FUEL_TYPE];
  const capacityL = descriptor.fuelTankL ?? DEFAULT_TANK_L;
  const ratedW = (descriptor.enginePowerHp ?? 0) * W_PER_HP;
  const idleRpm = descriptor.idleRpm;
  const idleLps = (descriptor.idleFuelLph ?? (ratedW / 1000) * IDLE_FUEL_LPH_PER_KW) / 3600;
  const litresPerJoule = fuel.bsfc / 3.6e9 / fuel.density;

  const dryMass = chassisBody.mass;
  const dryInertia = chassisBody.inertia.clone();
  let appliedFuelKg = -Infinity;
  let cargoKg = 0;

  const buckets = []; // { litres, metres, seconds }, oldest first
  let current = { litres: 0, metres: 0, seconds: 0 };

  const tank = {
    capacityL,
    litres: capacityL,
    refillWhenEmpty: true,
    get fraction() {
      return tank.litres / capacityL;
    },
    update,
    setLitres,
    setCargoKg,
    getAverage,
  };

  function applyMass() {
    const fuelKg = tank.litres * fuel.density;
    if (Math.abs(fuelKg - appliedFuelKg) < MASS_UPDATE_KG) return;
    appliedFuelKg = fuelKg;
    const mass = dryMass + fuelKg + cargoKg;
    const scale = mass / dryMass;
    chassisBody.mass = mass;
    chassisBody.invMass = 1 / mass;
    chassisBody.inertia.set(dryInertia.x * scale, dryInertia.y * scale, dryInertia.z * scale);
    chassisBody.invInertia.set(
      chassisBody.inertia.x > 0 ? 1 / chassisBody.inertia.x : 0,
      chassisBody.inertia.y > 0 ? 1 / chassisBody.inertia.y : 0,
      chassisBody.inertia.z > 0 ? 1 / chassisBody.inertia.z : 0
    );
    chassisBody.updateInertiaWorld(true);
  }

  function setLitres(litres) {
    tank.litres = Math.min(capacityL, Math.max(0, litres));
    applyMass();
  }

  /** Extra load carried with the fuel (kg). */
  function setCargoKg(kg) {
    cargoKg = Math.max(0, kg);
    appliedFuelKg = -Infinity;
    applyMass();
  }

  /** Burns fuel for `dt` s at the engine's current throttle, load and rpm. */
  function update(dt, engine) {
    if (dt <= 0) return;
    const throttle = engine.throttle ?? 0;
    const runningLps = idleLps * Math.max(1, (engine.rpm / idleRpm) * throttle);
    const burnt = (engine.loadFraction * ratedW * litresPerJoule + runningLps) * dt;
    tank.litres -= burnt;
    if (tank.litres <= 0) tank.litres = tank.refillWhenEmpty ? capacityL : 0;
    applyMass();

    current.litres += burnt;
    current.metres += chassisBody.velocity.length() * dt;
    current.seconds += dt;
    if (current.seconds >= 1) {
      buckets.push(current);
      if (buckets.length > AVERAGE_WINDOW_S) buckets.shift();
      current = { litres: 0, metres: 0, seconds: 0 };
    }
  }

  /** Consumption over the last minute: { litresPerHour, litresPer100Km (null when barely moving) }. */
  function getAverage() {
    let litres = current.litres;
    let metres = current.metres;
    let seconds = current.seconds;
    for (const b of buckets) {
      litres += b.litres;
      metres += b.metres;
      seconds += b.seconds;
    }
    return {
      litresPerHour: seconds > 0 ? (litres / seconds) * 3600 : 0,
      litresPer100Km: metres > 100 ? (litres / metres) * 100000 : null,
    };
  }

  applyMass();
  return tank;
}
