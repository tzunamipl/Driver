// Tyre debug panel: per wheel tread (slider sets it), grip, Pop / Fix; Pop all / New for the set.
import { tyreGrip } from '../lib/tyres.js';

export function createTyreHud() {
  const panel = document.getElementById('tyre-hud');
  const list = document.getElementById('tyre-hud-list');
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

  function rebuildRows(wheelInfos, labels) {
    list.innerHTML = '';
    rows = wheelInfos.map((_, i) => {
      const row = document.createElement('div');
      row.className = 'tyre-row';
      row.innerHTML =
        `<span class="tyre-label">${labels?.[i] ?? i}</span>` +
        '<input type="range" min="0" max="100" step="1" class="tyre-tread">' +
        '<span class="tyre-val">&mdash;</span>' +
        '<button type="button" class="tyre-toggle"></button>';
      list.appendChild(row);
      const slider = row.querySelector('.tyre-tread');
      const toggle = row.querySelector('.tyre-toggle');
      slider.addEventListener('input', () => {
        const wheel = vehicle?.wheelInfos[i];
        if (wheel) wheel.tread = Number(slider.value) / 100;
      });
      slider.addEventListener('change', () => slider.blur());
      onClick(toggle, (v) => (v.wheelInfos[i].punctured ? v.inflateTyre(i) : v.popTyre(i)));
      return { slider, toggle, val: row.querySelector('.tyre-val') };
    });
  }

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

    let hardestHit = null;
    vehicle.wheelInfos.forEach((wheel, i) => {
      const { slider, toggle, val } = rows[i];
      const tread = Math.round(wheel.tread * 100);
      if (document.activeElement !== slider) slider.value = String(tread);
      val.textContent = wheel.punctured ? 'FLAT' : `${tread}%`;
      val.classList.toggle('flat', wheel.punctured);
      val.title = `Grip x${tyreGrip(wheel).toFixed(2)}`;
      toggle.textContent = wheel.punctured ? 'Fix' : 'Pop';
      toggle.title = wheel.punctured ? 'Debug: reinflate (tread unchanged; a bald tyre pops again)' : 'Debug: pop this tyre';
      const ratio = wheel.lastStrikeLimit > 0 ? wheel.lastStrikeSpeed / wheel.lastStrikeLimit : 0;
      if (ratio > 0 && (!hardestHit || ratio > hardestHit.ratio)) hardestHit = { ratio, wheel };
    });
    hitEl.textContent = hardestHit
      ? `${hardestHit.wheel.lastStrikeSpeed.toFixed(1)} / ${hardestHit.wheel.lastStrikeLimit.toFixed(1)}`
      : '—';
  }

  return { updateTyreHud };
}
