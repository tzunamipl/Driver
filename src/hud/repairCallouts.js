// Floating repair buttons, each with a leader line down to its part on screen
// (placed on the car by app/partCallouts.js).
// Cards on the same side of the screen stack instead of overlapping.

const SVG_NS = 'http://www.w3.org/2000/svg';
// Card centre offset from its part (px): up, and out to the part's side of the screen.
const OFFSET_X = 120;
const OFFSET_Y = -110;
const MARGIN = 12;
const GAP = 6;

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });

export function createRepairCallouts() {
  const root = document.getElementById('repair-callouts');
  const svg = document.createElementNS(SVG_NS, 'svg');
  root.append(svg);
  const callouts = []; // { card, button, note, line, dot, key, onClick }

  function callout(i) {
    if (callouts[i]) return callouts[i];
    const line = document.createElementNS(SVG_NS, 'line');
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('r', '6');
    svg.append(line, dot);
    const card = el('div', 'repair-callout');
    const button = Object.assign(el('button', 'repair-callout-fit'), { type: 'button' });
    const note = el('div', 'repair-callout-note');
    card.append(button, note);
    root.append(card);
    const c = { card, button, note, line, dot, key: '', onClick: null };
    button.addEventListener('click', () => {
      button.blur();
      c.onClick?.();
    });
    return (callouts[i] = c);
  }

  function show(c, on) {
    c.card.hidden = !on;
    c.line.style.display = c.dot.style.display = on ? '' : 'none';
  }

  return {
    /**
     * @param {Array<{ x: number, y: number, label: string, note?: string, disabled?: boolean, side?: -1 | 1, onClick: () => void }> | null} views -
     *   x / y: the part in viewport px; side: which way the card goes (default: away from the screen centre); null / empty hides them.
     */
    render(views) {
      const list = views ?? [];
      root.hidden = !list.length;
      callouts.forEach((c, i) => show(c, i < list.length));
      if (!list.length) return;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const placed = list.map((view, i) => {
        const c = callout(i);
        show(c, true);
        c.onClick = view.onClick;
        const key = `${view.label}|${view.note ?? ''}|${!!view.disabled}`;
        if (key !== c.key) {
          c.key = key;
          c.button.textContent = view.label;
          c.button.disabled = !!view.disabled;
          c.note.textContent = view.note ?? '';
          c.note.hidden = !view.note;
        }
        const side = view.side ?? (view.x < w / 2 ? -1 : 1);
        const halfW = c.card.offsetWidth / 2;
        const halfH = c.card.offsetHeight / 2;
        return { c, view, side, halfW, halfH, cx: view.x + side * OFFSET_X, cy: view.y + OFFSET_Y };
      });
      for (const side of [-1, 1]) {
        let bottom = -Infinity;
        for (const p of placed.filter((q) => q.side === side).sort((a, b) => a.cy - b.cy)) {
          p.cy = Math.max(p.cy, bottom + GAP + p.halfH);
          bottom = p.cy + p.halfH;
        }
      }
      for (const { c, view, halfW, halfH, cx: x, cy: y } of placed) {
        const cx = Math.min(w - MARGIN - halfW, Math.max(MARGIN + halfW, x));
        const cy = Math.min(h - MARGIN - halfH, Math.max(MARGIN + halfH, y));
        c.card.style.transform = `translate(${cx - halfW}px, ${cy - halfH}px)`;
        // From the card's edge nearest the part (its bottom when above it).
        const fromY = view.y > cy ? cy + halfH : cy - halfH;
        c.line.setAttribute('x1', cx);
        c.line.setAttribute('y1', fromY);
        c.line.setAttribute('x2', view.x);
        c.line.setAttribute('y2', view.y);
        c.dot.setAttribute('cx', view.x);
        c.dot.setAttribute('cy', view.y);
      }
    },
  };
}
