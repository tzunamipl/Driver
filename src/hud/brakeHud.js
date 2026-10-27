// Brake debug panel (lib/brakes.js): per wheel rotor temperature and health (sliders set them),
// pad fade, pedal force share and cooling rate; fluid, leaks and line pressure, with Heat / Leak / Fix buttons.

const MAX_TEMP_C = 1000;

export function createBrakeHud() {
  const panel = document.getElementById('brake-hud');
  const list = document.getElementById('brake-hud-list');
  const fluidEl = document.getElementById('brake-hud-fluid');
  const pctEl = document.getElementById('brake-hud-pct');
  const leaksEl = document.getElementById('brake-hud-leaks');
  const pressureEl = document.getElementById('brake-hud-pressure');
  let vehicle = null;
  let rows = [];
  let builtFor = null;

  // Blur so Space / arrows (driving keys) don't keep working the focused control.
  function onClick(id, action) {
    const button = document.getElementById(id);
    button?.addEventListener('click', () => {
      if (vehicle?.brakes) action(vehicle.brakes);
      button.blur();
    });
  }
  onClick('brake-hud-heat', (b) => b.discs.forEach((d) => (d.tempC += 300)));
  onClick('brake-hud-leak-front', (b) => b.startLeak('front'));
  onClick('brake-hud-leak-rear', (b) => b.startLeak('rear'));
  onClick('brake-hud-fix', (b) => b.repair());

  /** Range input writing `set(disc, value)` on rotor i while dragged. */
  function slider(row, min, max, i, set) {
    const input = Object.assign(document.createElement('input'), { type: 'range', min, max, step: 1 });
    input.addEventListener('input', () => {
      const disc = vehicle?.brakes?.discs[i];
      if (disc) set(disc, Number(input.value));
    });
    input.addEventListener('change', () => input.blur());
    row.appendChild(input);
    return input;
  }

  function span(row, className, text = '') {
    const el = Object.assign(document.createElement('span'), { className, textContent: text });
    row.appendChild(el);
    return el;
  }

  function rebuildRows(brakes, labels) {
    list.innerHTML = '';
    rows = brakes.discs.map((d, i) => {
      const row = document.createElement('div');
      row.className = 'brake-row';
      const label = span(row, 'brake-label', String(labels?.[i] ?? i));
      label.title = d.type === 'drum' ? `Drum ${Math.round(d.diameterM * 1000)} mm` : `Disc ${Math.round(d.diameterM * 1000)} mm${d.vented ? ' vented' : ''}${d.race ? ', race pads' : ''}`;
      const temp = slider(row, 0, MAX_TEMP_C, i, (disc, v) => (disc.tempC = v));
      const tempVal = span(row, 'brake-val');
      const health = slider(row, 0, 100, i, (disc, v) => (disc.health = v / 100));
      const healthVal = span(row, 'brake-val');
      const cond = span(row, 'brake-cond');
      list.appendChild(row);
      return { temp, tempVal, health, healthVal, cond };
    });
  }

  const syncSlider = (input, value) => {
    if (document.activeElement !== input) input.value = String(value);
  };
  const pct = (v) => Math.round(v * 100);

  function updateBrakeHud(nextVehicle, debugVisualsEnabled) {
    if (!debugVisualsEnabled || !nextVehicle) return;
    vehicle = nextVehicle;
    const brakes = vehicle.brakes;
    panel.hidden = !brakes;
    if (!brakes) return;
    if (builtFor !== brakes) {
      rebuildRows(brakes, vehicle.wheelLabels);
      builtFor = brakes;
    }
    brakes.discs.forEach((d, i) => {
      const { temp, tempVal, health, healthVal, cond } = rows[i];
      const fade = brakes.fade(d);
      syncSlider(temp, Math.round(d.tempC));
      tempVal.textContent = `${Math.round(d.tempC)}°`;
      tempVal.classList.toggle('hot', fade < 1);
      syncSlider(health, pct(d.health));
      healthVal.textContent = `${pct(d.health)}%`;
      cond.textContent = `${d.type} · fade x${fade.toFixed(2)} · pedal ${pct(brakes.pedalFactor(i))}% · cool ${d.coolKps.toFixed(0)} K/s`;
    });
    fluidEl.textContent = `${brakes.fluidL.toFixed(2)}/${brakes.capacityL.toFixed(2)}`;
    pctEl.textContent = pct(brakes.level);
    leaksEl.textContent = `${(brakes.circuits.front.leakLps * 60).toFixed(3)}/${(brakes.circuits.rear.leakLps * 60).toFixed(3)}`;
    pressureEl.textContent = `${pct(brakes.pressureFactor('front'))}/${pct(brakes.pressureFactor('rear'))}`;
  }

  return { updateBrakeHud };
}
