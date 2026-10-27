// Tyre debug panel: fitted setup; per wheel tread, temperature and dirt (sliders set them),
// Pop / Fix, Rim (break / fix the rim), then wetness and grip factors; Pop all / New for the set.
import { tyreGrip, treadGrip, gripBreakdown } from '../lib/tyres.js';
import { getTyreCompound } from '../lib/tyres/compounds.js';
import { tyreSizeLabel } from '../lib/tyres/setup.js';

export function createTyreHud() {
  const panel = document.getElementById('tyre-hud');
  const list = document.getElementById('tyre-hud-list');
  const setupEl = document.getElementById('tyre-hud-setup');
  const hitEl = document.getElementById('susp-tyre-hit');
  const popAllBtn = document.getElementById('tyre-hud-pop-all');
  const newBtn = document.getElementById('tyre-hud-new');
  let vehicle = null;
  let rows = [];
  let lastSignature = '';

  // Blur so Space / arrows (driving keys) don't keep working the focused control.
  function onClick(button, action) {
    button?.addEventListener('click', () => {
      if (vehicle) action(vehicle);
      button.blur();
    });
  }
  onClick(popAllBtn, (v) => v.wheelInfos.forEach((_, i) => v.popTyre(i)));
  onClick(newBtn, (v) => v.repairTyres());

  /** Range input writing `set(wheel, value)` on wheel i while dragged. */
  function slider(row, className, min, max, i, set) {
    const input = Object.assign(document.createElement('input'), { type: 'range', min, max, step: 1, className });
    input.addEventListener('input', () => {
      const wheel = vehicle?.wheelInfos[i];
      if (wheel) set(wheel, Number(input.value));
    });
    input.addEventListener('change', () => input.blur());
    row.appendChild(input);
    return input;
  }

  function span(row, className, html = '') {
    const el = document.createElement('span');
    el.className = className;
    el.innerHTML = html;
    row.appendChild(el);
    return el;
  }

  function rebuildRows(wheelInfos, labels) {
    list.innerHTML = '';
    rows = wheelInfos.map((_, i) => {
      const row = document.createElement('div');
      row.className = 'tyre-row';
      span(row, 'tyre-label', String(labels?.[i] ?? i));
      const tread = slider(row, 'tyre-tread', 0, 100, i, (w, v) => (w.tread = v / 100));
      const val = span(row, 'tyre-val', '&mdash;');
      const toggle = Object.assign(document.createElement('button'), { type: 'button', className: 'tyre-toggle' });
      row.appendChild(toggle);
      onClick(toggle, (v) => (v.wheelInfos[i].punctured ? v.inflateTyre(i) : v.popTyre(i)));
      const rim = Object.assign(document.createElement('button'), { type: 'button', className: 'tyre-toggle', textContent: 'Rim' });
      row.appendChild(rim);
      onClick(rim, (v) => (v.wheelInfos[i].rimBroken ? v.fixRim(i) : v.breakRim(i)));
      span(row, 'tyre-sub', '&deg;C');
      const temp = slider(row, 'tyre-temp', -20, 200, i, (w, v) => (w.tempC = v));
      const tempVal = span(row, 'tyre-val tyre-wide');
      span(row, 'tyre-sub', 'dirt');
      const dirt = slider(row, 'tyre-dirt', 0, 100, i, (w, v) => (w.dirt = v / 100));
      const dirtVal = span(row, 'tyre-val tyre-wide');
      const cond = span(row, 'tyre-cond');
      list.appendChild(row);
      return { tread, toggle, rim, val, temp, tempVal, dirt, dirtVal, cond };
    });
  }

  const syncSlider = (input, value) => {
    if (document.activeElement !== input) input.value = String(value);
  };

  function updateTyreHud(nextVehicle, debugVisualsEnabled) {
    if (!debugVisualsEnabled || !nextVehicle) return;
    vehicle = nextVehicle;
    const hasTyres = vehicle.wheelInfos[0]?.tread !== undefined && !!vehicle.popTyre;
    panel.hidden = !hasTyres;
    if (!hasTyres) return;

    const signature = `${vehicle.wheelInfos.length}:${vehicle.wheelLabels?.join(',') ?? ''}`;
    if (signature !== lastSignature) {
      rebuildRows(vehicle.wheelInfos, vehicle.wheelLabels);
      lastSignature = signature;
    }

    const setup = vehicle.tyreSetup;
    setupEl.textContent = setup ? `${getTyreCompound(setup.compound).label} ${tyreSizeLabel(setup)}` : '';

    let hardestHit = null;
    vehicle.wheelInfos.forEach((wheel, i) => {
      const { tread: treadInput, toggle, rim, val, temp, tempVal, dirt, dirtVal, cond } = rows[i];
      const tread = Math.round(wheel.tread * 100);
      syncSlider(treadInput, tread);
      syncSlider(temp, Math.round(wheel.tempC));
      tempVal.textContent = `${Math.round(wheel.tempC)}°`;
      syncSlider(dirt, Math.round(wheel.dirt * 100));
      dirtVal.textContent = `${Math.round(wheel.dirt * 100)}%`;
      val.textContent = wheel.rimBroken ? 'RIM' : wheel.punctured ? 'FLAT' : `${tread}%`;
      val.classList.toggle('flat', wheel.punctured || wheel.rimBroken);
      val.title = `Grip x${tyreGrip(wheel).toFixed(2)}`;
      const g = gripBreakdown(wheel);
      cond.textContent = `wet ${Math.round(wheel.wetness * 100)}% · grip x${tyreGrip(wheel).toFixed(2)}`;
      cond.title =
        `${wheel.surface}: compound x${g.compound.toFixed(2)}, tread x${treadGrip(wheel).toFixed(2)}, ` +
        `temp x${g.temp.toFixed(2)}, wet x${g.wet.toFixed(2)}, dirt x${g.dirt.toFixed(2)}`;
      toggle.textContent = wheel.punctured ? 'Fix' : 'Pop';
      toggle.title = wheel.punctured ? 'Debug: reinflate (tread unchanged; a bald tyre pops again)' : 'Debug: pop this tyre';
      rim.classList.toggle('broken', wheel.rimBroken);
      rim.title = wheel.rimBroken ? 'Debug: straighten this rim' : 'Debug: break this rim (oval, hub drops twice a revolution)';
      const ratio = wheel.lastStrikeLimit > 0 ? wheel.lastStrikeSpeed / wheel.lastStrikeLimit : 0;
      if (ratio > 0 && (!hardestHit || ratio > hardestHit.ratio)) hardestHit = { ratio, wheel };
    });
    hitEl.textContent = hardestHit
      ? `${hardestHit.wheel.lastStrikeSpeed.toFixed(1)} / ${hardestHit.wheel.lastStrikeLimit.toFixed(1)}`
      : '—';
  }

  return { updateTyreHud };
}
