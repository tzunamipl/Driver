// Rally service (points of a SERVICE_ZONES type, or a click on their props) and car inspection
// (stopped anywhere): every part's condition (lib/serviceRepairs.js carParts), group by group.
// In a service each damaged part offers Fix / Replace against the zone's time budget; going
// over it costs a late penalty. Inspection offers the field fixes, done on the click.

import { latePenaltyMs } from '../lib/serviceRepairs.js';
import { formatTime } from '../hud/rallyHud.js';
import { penaltyText } from '../app/rally/fieldRepair.js';

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });
const VERDICT_TEXT = { good: 'OK', warn: 'Worn', bad: 'Bad' };
const minText = (m) => `${m} min`;
const GROUP_ICONS = { Tyres: '🛞', Suspension: '🔩', Cooling: '🌡️', Engine: '🛢️', Lamps: '💡', Drivetrain: '⚙️', Brakes: '🛑', 'Fuel & spares': '⛽' };

/**
 * @param {object} [opts]
 * @param {() => void} [opts.onOpen] - e.g. park the car while the dialog covers the game.
 * @param {() => void} [opts.onClose]
 */
export function createServiceDialog({ onOpen, onClose } = {}) {
  const root = document.getElementById('service-dialog');
  let pending = null;

  /**
   * Resolves with the picked actions ([{ minutes, apply }], empty when none or for an inspection).
   * @param {() => object[]} getParts - carParts(vehicle), asked again after a field fix.
   * @param {object} [opts]
   * @param {{ label: string, budgetMin: number, replace: boolean } | null} [opts.zone] - null: inspection.
   * @param {number} [opts.usedMin] - minutes this visit already spent.
   * @param {(action: object, part: object) => void} [opts.fieldFix] - inspection: does a field action; none: read only.
   * @param {() => boolean} [opts.penaltyApplies] - inspection: field fixes cost stage time now.
   */
  function open(getParts, { zone = null, usedMin = 0, fieldFix = null, penaltyApplies = () => false } = {}) {
    if (pending) return pending;
    pending = new Promise((resolve) => {
      let parts = [];
      const picked = new Map(); // part -> action
      let rows = []; // { part, buttons: Map(action -> button) }
      const allowed = (action) => !!zone && (zone.replace || action.remote);
      const shownActions = (part) => part.actions.filter((a) => (zone ? a.kind !== 'field' : !!fieldFix && a.kind === 'field'));

      const finish = (actions) => {
        root.hidden = true;
        pending = null;
        onClose?.();
        resolve(actions);
      };

      const meter = el('span', 'tyre-setup-bar service-meter');
      const meterText = el('span', 'tyre-setup-val');
      const verdict = el('div', 'service-budget-note');
      const repair = Object.assign(el('button', '', 'Repair'), { type: 'button' });

      function render() {
        for (const { part, buttons } of rows) {
          for (const [action, button] of buttons) button.classList.toggle('selected', picked.get(part) === action);
        }
        if (!zone) return;
        const planned = [...picked.values()].reduce((sum, a) => sum + a.minutes, 0);
        const total = usedMin + planned;
        const scale = Math.max(zone.budgetMin, total);
        meter.style.setProperty('--fill', `${(Math.min(usedMin, scale) / scale) * 100}%`);
        meter.style.setProperty('--add', `${(Math.min(total, zone.budgetMin) / scale) * 100}%`);
        meter.style.setProperty('--over', `${(total / scale) * 100}%`);
        meterText.textContent = `${total} / ${zone.budgetMin} min`;
        const extraMs = latePenaltyMs(total, zone.budgetMin) - latePenaltyMs(usedMin, zone.budgetMin);
        const left = zone.budgetMin - total;
        verdict.textContent = left >= 0 ? `${minText(left)} left${usedMin ? ` · ${minText(usedMin)} already spent here` : ''}` : `Over by ${minText(-left)}: +${formatTime(extraMs)} penalty`;
        verdict.classList.toggle('over', left < 0);
        repair.textContent = planned ? `Repair · ${minText(planned)}` : 'Repair';
        repair.disabled = !planned;
      }

      /** 'fix': every Fix on offer; 'replace': every Replace, else the Fix; null: clears. */
      function pickAll(kind) {
        picked.clear();
        if (kind) {
          for (const part of parts) {
            const usable = shownActions(part).filter(allowed);
            const fix = usable.find((a) => a.kind === 'fix');
            const action = kind === 'fix' ? fix : usable.find((a) => a.kind === 'replace') ?? fix;
            if (action) picked.set(part, action);
          }
        }
        render();
      }

      function partRow(part) {
        const row = el('div', 'service-row');
        const bar = el('span', 'tyre-setup-bar');
        if (part.level != null) {
          bar.style.setProperty('--fill', `${Math.round(Math.min(1, Math.max(0, part.level)) * 100)}%`);
          const tone = { good: 'good', warn: 'warn', bad: 'poor' }[part.verdict];
          if (tone) bar.classList.add(tone);
        } else bar.classList.add('service-bar-none');
        const chip = el('span', `tyre-service-verdict ${part.verdict}`, VERDICT_TEXT[part.verdict] ?? '');
        row.append(el('span', 'service-label', part.label), bar, el('span', 'service-note', part.note), chip);
        const buttons = new Map();
        if (!zone && fieldFix) {
          const cell = el('span', 'service-actions');
          const live = penaltyApplies();
          for (const action of shownActions(part)) {
            const cost = live && action.penaltyMs && !action.disabled ? ` · ${penaltyText(action.penaltyMs)}` : '';
            const button = Object.assign(el('button', 'service-action field', `${action.label}${cost}`), { type: 'button', disabled: !!action.disabled, title: [action.note, action.hint].filter(Boolean).join('. ') });
            button.onclick = () => {
              fieldFix(action, part);
              fillBody();
            };
            cell.append(button);
          }
          row.append(cell);
        } else if (zone) {
          const cell = el('span', 'service-actions');
          for (const action of shownActions(part)) {
            const ok = allowed(action);
            const button = Object.assign(el('button', `service-action ${action.kind}`, `${action.label} · ${action.minutes}′`), {
              type: 'button',
              disabled: !ok,
              title: ok ? action.hint ?? '' : 'Not at a remote service',
            });
            button.onclick = () => {
              if (picked.get(part) === action) picked.delete(part);
              else picked.set(part, action);
              render();
            };
            buttons.set(action, button);
            cell.append(button);
          }
          row.append(cell);
        }
        rows.push({ part, buttons });
        return row;
      }

      const body = el('div', 'service-groups');
      function fillBody() {
        parts = getParts();
        rows = [];
        const groups = new Map();
        body.replaceChildren();
        for (const part of parts) {
          if (!groups.has(part.group)) {
            const box = el('div', 'service-group');
            const title = el('div', 'tyre-setup-title', part.group);
            if (GROUP_ICONS[part.group]) title.prepend(el('span', 'service-group-icon', GROUP_ICONS[part.group]));
            box.append(title);
            groups.set(part.group, box);
            body.append(box);
          }
          groups.get(part.group).append(partRow(part));
        }
      }
      fillBody();

      const win = el('div', 'menu-window service-window');
      const footer = el('div', 'menu-footer');
      if (zone) {
        const anyAction = parts.some((p) => shownActions(p).some(allowed));
        const budget = el('div', 'refuel-row service-budget');
        budget.append(el('span', '', 'Time'), meter, meterText);
        const presets = el('div', 'service-presets');
        for (const [label, kind] of [['Fix all', 'fix'], ...(zone.replace ? [['Replace all', 'replace']] : []), ['Clear', null]]) {
          presets.append(Object.assign(el('button', '', label), { type: 'button', disabled: !anyAction, onclick: () => pickAll(kind) }));
        }
        const hint = anyAction ? `${minText(zone.budgetMin)} of service time${zone.replace ? '' : ': the crew can fix, not replace'}. Late out costs a penalty.` : 'Nothing to repair.';
        win.append(el('h1', 'menu-titlebar', zone.label), el('p', 'tyre-service-hint', hint), budget, verdict, presets, body);
        repair.onclick = () => finish([...picked.values()]);
        footer.append(repair, Object.assign(el('button', '', 'Leave'), { type: 'button', onclick: () => finish([]) }));
      } else {
        win.classList.add('service-inspect');
        const live = !!fieldFix && penaltyApplies();
        const hint = fieldFix ? `Field fixes are done on the spot${live ? `, each adds to the stage time` : ''}.` : '';
        win.append(el('h1', 'menu-titlebar', 'Car inspection'), ...(hint ? [el('p', 'tyre-service-hint', hint)] : []), body);
        footer.append(Object.assign(el('button', '', 'Close'), { type: 'button', onclick: () => finish([]) }));
      }
      win.append(footer);
      root.replaceChildren(win);
      root.classList.toggle('inspecting', !zone);
      render();
      root.hidden = false;
      onOpen?.();
    });
    return pending;
  }

  return { open, isOpen: () => !!pending };
}
