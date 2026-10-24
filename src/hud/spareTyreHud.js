// Floating "fit spare" button with a leader line down to the flat wheel on screen
// (app/rally/spareTyreFix.js places it every frame).

const SVG_NS = 'http://www.w3.org/2000/svg';
// Button centre offset from the wheel (px): up, and out to the wheel's side of the screen.
const OFFSET_X = 120;
const OFFSET_Y = -110;
const MARGIN = 12;

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, ...(text ? { textContent: text } : {}) });

/** @param {{ onFit: () => void }} actions */
export function createSpareTyreHud({ onFit }) {
  const root = document.getElementById('spare-tyre-hud');
  const svg = document.createElementNS(SVG_NS, 'svg');
  const line = document.createElementNS(SVG_NS, 'line');
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('r', '6');
  svg.append(line, dot);
  const card = el('div', 'spare-tyre-card');
  const button = Object.assign(el('button', 'spare-tyre-fit'), { type: 'button' });
  button.addEventListener('click', () => {
    button.blur();
    onFit();
  });
  const note = el('div', 'spare-tyre-note');
  card.append(button, note);
  root.append(svg, card);
  let shownKey = '';

  return {
    /**
     * @param {{ x: number, y: number, label: string, note: string, disabled: boolean } | null} view -
     *   x / y: the wheel in viewport px; null hides it.
     */
    render(view) {
      root.hidden = !view;
      if (!view) return;
      const key = `${view.label}|${view.note}|${view.disabled}`;
      if (key !== shownKey) {
        shownKey = key;
        button.textContent = view.label;
        button.disabled = view.disabled;
        note.textContent = view.note;
        note.hidden = !view.note;
      }
      const w = window.innerWidth;
      const h = window.innerHeight;
      const halfW = card.offsetWidth / 2;
      const halfH = card.offsetHeight / 2;
      const side = view.x < w / 2 ? -1 : 1;
      const cx = Math.min(w - MARGIN - halfW, Math.max(MARGIN + halfW, view.x + side * OFFSET_X));
      const cy = Math.min(h - MARGIN - halfH, Math.max(MARGIN + halfH, view.y + OFFSET_Y));
      card.style.transform = `translate(${cx - halfW}px, ${cy - halfH}px)`;
      // From the card's edge nearest the wheel (its bottom when above it).
      const fromY = view.y > cy ? cy + halfH : cy - halfH;
      line.setAttribute('x1', cx);
      line.setAttribute('y1', fromY);
      line.setAttribute('x2', view.x);
      line.setAttribute('y2', view.y);
      dot.setAttribute('cx', view.x);
      dot.setAttribute('cy', view.y);
    },
  };
}
