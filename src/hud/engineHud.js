// Engine debug panel: fuel consumption, cooling, oil and gearbox wear, with Leak / Wear / Fix buttons.

export function createEngineHud({ partClunkSound } = {}) {
  const fuelRow = document.getElementById('susp-fuel');
  const fuelPer100 = document.getElementById('susp-fuel-per100');
  const fuelPerHour = document.getElementById('susp-fuel-perhour');
  const fuelTank = document.getElementById('susp-fuel-tank');
  const heatRow = document.getElementById('susp-heat');
  const heatEls = Object.fromEntries(
    ['block', 'coolant', 'ambient', 'thermostat', 'fan', 'in', 'rad', 'power', 'level', 'loss', 'radiator'].map((k) => [k, document.getElementById(`susp-heat-${k}`)])
  );
  const oilRow = document.getElementById('susp-oil');
  const oilEls = Object.fromEntries(
    ['temp', 'pressure', 'level', 'pct', 'loss', 'leak-rate', 'sump', 'engine'].map((k) => [k, document.getElementById(`susp-oil-${k}`)])
  );
  let heatVehicle = null; // for the debug Leak / Fix buttons
  for (const [id, action] of [
    ['susp-heat-leak', (h) => { h.startLeak(); partClunkSound?.play(1, 'radiator'); }],
    ['susp-heat-fix', (h) => h.repairRadiator()],
    ['susp-oil-leak', (h) => { h.startOilLeak(); partClunkSound?.play(1, 'sump'); }],
    ['susp-oil-fix', (h) => { h.repairSump(); h.repairEngine(); }],
  ]) {
    const button = document.getElementById(id);
    // Blur so Space (handbrake) doesn't re-click the focused button.
    button?.addEventListener('click', () => {
      if (heatVehicle?.heat) action(heatVehicle.heat);
      button.blur();
    });
  }

  const gearboxRow = document.getElementById('susp-gearbox');
  const gearboxHealth = document.getElementById('susp-gearbox-health');
  const gearboxShift = document.getElementById('susp-gearbox-shift');
  for (const [id, action] of [['susp-gearbox-wear', (g) => g.wear()], ['susp-gearbox-fix', (g) => g.repair()]]) {
    const button = document.getElementById(id);
    button?.addEventListener('click', () => {
      if (heatVehicle?.engine?.gearbox) action(heatVehicle.engine.gearbox);
      button.blur();
    });
  }

  function updateEngineHud(vehicle, debugVisualsEnabled) {
    if (!debugVisualsEnabled || !vehicle) return;
    if (fuelRow) fuelRow.hidden = !vehicle.fuel;
    if (fuelRow && vehicle.fuel) {
      const { litresPerHour, litresPer100Km } = vehicle.fuel.getAverage();
      fuelPer100.textContent = litresPer100Km === null ? '—' : litresPer100Km.toFixed(1);
      fuelPerHour.textContent = litresPerHour.toFixed(1);
      fuelTank.textContent = `${vehicle.fuel.litres.toFixed(1)}/${vehicle.fuel.capacityL}`;
    }
    if (heatRow) heatRow.hidden = !vehicle.heat;
    if (heatRow && vehicle.heat) {
      const heat = vehicle.heat;
      heatEls.block.textContent = heat.blockTempC.toFixed(0);
      heatEls.coolant.textContent = heat.coolantTempC.toFixed(0);
      heatEls.ambient.textContent = heat.ambientC.toFixed(0);
      heatEls.thermostat.textContent = Math.round(heat.thermostat * 100);
      heatEls.fan.textContent = heat.fanOn ? ', fan' : '';
      heatEls.in.textContent = (heat.heatInW / 1000).toFixed(1);
      heatEls.rad.textContent = (heat.radiatorW / 1000).toFixed(1);
      heatEls.power.textContent = Math.round(heat.powerFactor * 100);
      heatEls.level.textContent = `${heat.coolantL.toFixed(1)}/${heat.capacityL.toFixed(1)}`;
      heatEls.loss.textContent = (heat.lossLps * 60).toFixed(2);
      heatEls.radiator.textContent = Math.round(heat.radiatorHealth * 100);
      heatVehicle = vehicle;
    }
    if (oilRow) oilRow.hidden = !vehicle.heat;
    if (oilRow && vehicle.heat) {
      const heat = vehicle.heat;
      oilEls.temp.textContent = heat.oilTempC.toFixed(0);
      oilEls.pressure.textContent = vehicle.engine.oilPressureBar.toFixed(1);
      oilEls.level.textContent = `${heat.oilL.toFixed(2)}/${heat.oilCapacityL.toFixed(1)}`;
      oilEls.pct.textContent = Math.round(heat.oilLevel * 100);
      oilEls.loss.textContent = (heat.oilLossLps * 60).toFixed(3);
      oilEls['leak-rate'].textContent = (heat.oilLeakLps * 60).toFixed(3);
      oilEls.sump.textContent = Math.round(heat.sumpHealth * 100);
      oilEls.engine.textContent = Math.round(heat.engineHealth * 100);
    }
    const gearbox = vehicle.engine?.gearbox;
    if (gearboxRow) gearboxRow.hidden = !gearbox;
    if (gearboxRow && gearbox) {
      gearboxHealth.textContent = Math.round(gearbox.health * 100);
      gearboxShift.textContent = gearbox.shiftFactor.toFixed(1);
      heatVehicle = vehicle;
    }
  }

  return { updateEngineHud };
}
