// Rally plan, top right under the players panel: the itinerary in order with what has been
// passed and stage times. Folds on its title.

const NARROW = '(max-width: 800px)';

const el = (tag, className, textContent = '') => Object.assign(document.createElement(tag), { className, textContent });
const MARKS = { done: '✓', current: '▶' };
const ICONS = { service: '🔧', refuel: '⛽', tyres: '🛞', parc: '🅿️', podium: '🏆', parkIn: '↘', parkOut: '↗' };

export function createRallyPlanHud() {
  const root = document.getElementById('rally-plan');
  const toggle = Object.assign(el('button', 'rally-plan-title'), { type: 'button' });
  const name = el('span', 'rally-plan-name');
  const clock = el('span', 'rally-plan-clock');
  toggle.append(name, clock);
  const list = el('div', 'rally-plan-list');
  root.append(toggle, list);
  if (window.matchMedia(NARROW).matches) root.classList.add('collapsed');
  toggle.addEventListener('click', () => root.classList.toggle('collapsed'));

  return {
    /**
     * @param {{title: string, rows: {label: string, value?: string, state: 'done' | 'current' | '', icon?: 'service' | 'refuel' | 'tyres' | 'parc' | 'podium' | 'parkIn' | 'parkOut' | '', endsDay?: boolean}[]} | null} view
     *   - null hides the panel.
     */
    render(view) {
      root.hidden = !view;
      if (!view) return;
      name.textContent = view.title;
      list.replaceChildren(
        ...view.rows.map(({ label, value, state, icon, endsDay }) => {
          const row = el('div', `rally-plan-row${state ? ` ${state}` : ''}${endsDay ? ' ends-day' : ''}`);
          // The tick replaces the icon once passed; the current row is already highlighted.
          const iconMark = state !== 'done' && ICONS[icon];
          const mark = el('span', `rally-plan-mark${iconMark ? ' icon' : ''}`, iconMark || (MARKS[state] ?? ''));
          row.append(mark, el('span', 'rally-plan-label', label), el('span', 'rally-plan-value', value ?? ''));
          return row;
        })
      );
      // Keep the current row in view.
      const current = list.querySelector('.current');
      if (current) list.scrollTop = current.offsetTop - list.clientHeight / 2;
    },

    /** @param {string} text - rally clock, e.g. 'Day 2 · 14:35'; '' hides it. Cheap to call every frame. */
    setClock(text) {
      if (clock.textContent !== text) clock.textContent = text;
      clock.hidden = !text;
    },
  };
}
