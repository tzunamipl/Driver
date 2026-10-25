// Rally info (a click on the rally base's tents): conditions, then the itinerary with stage
// lengths, splits, your best and this run's times / service visits, and the totals so far. Read only.

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text != null ? { textContent: text } : {}) });
const MARKS = { done: '✓', current: '▶' };

/**
 * @param {object} [opts]
 * @param {() => void} [opts.onOpen] - e.g. park the car while the dialog covers the game.
 * @param {() => void} [opts.onClose]
 */
export function createRallyInfoDialog({ onOpen, onClose } = {}) {
  const root = document.getElementById('rally-info');
  let open = false;

  function close() {
    root.hidden = true;
    open = false;
    onClose?.();
  }

  function table(head, rows) {
    const t = el('table', 'rally-info-table');
    const tr = el('tr');
    for (const text of head) tr.append(el('th', '', text));
    t.append(tr);
    for (const { cells, className = '' } of rows) {
      const row = el('tr', className);
      for (const text of cells) row.append(el('td', '', text));
      t.append(row);
    }
    return t;
  }

  return {
    /**
     * @param {{title: string, vehicle: string, conditions: [string, string][], rows: {state: string, label: string, km: string,
     *   splits: string, best: string, value: string}[], totals: [string, string][]}} info
     */
    open(info) {
      if (open) return;
      open = true;
      const conditions = el('dl', 'rally-info-conditions');
      for (const [label, value] of info.conditions) conditions.append(el('dt', '', label), el('dd', '', value));
      const itinerary = table(
        ['', 'Itinerary', 'km', 'Splits', 'Your best', 'This rally'],
        info.rows.map((r) => ({ cells: [MARKS[r.state] ?? '', r.label, r.km, r.splits, r.best, r.value], className: r.state }))
      );
      const totals = table(['Totals', ''], info.totals.map((cells) => ({ cells })));
      const scroll = el('div', 'rally-info-scroll');
      scroll.append(itinerary, totals);
      const footer = el('div', 'menu-footer');
      footer.append(Object.assign(el('button', '', 'Close'), { type: 'button', onclick: close }));
      const win = el('div', 'menu-window rally-info-window');
      win.append(
        el('h1', 'menu-titlebar', `Rally info · ${info.title}`),
        el('p', 'tyre-service-hint', info.vehicle),
        el('h2', 'rally-info-heading', 'Conditions'),
        conditions,
        scroll,
        footer
      );
      root.replaceChildren(win);
      root.hidden = false;
      onOpen?.();
    },
  };
}
