// Pacenote strip under the rally clock: the next few notes as tiles, the coming one first -
// an arrow bent by the grade, the call (L4, R2, Straight) and what follows it (a distance,
// into, and), with a fork icon at junctions.

import { noteLabel, gapLabel } from '../lib/rally/pacenoteCalls.js';
import { arrowPaths, ARROW_VIEWBOX, FORK_PATH } from '../lib/rally/pacenoteIcon.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

function arrowIcon(note) {
  const icon = svg('svg', { viewBox: ARROW_VIEWBOX, class: 'pacenote-arrow' });
  const { line, head } = arrowPaths(note);
  icon.append(svg('path', { d: line, class: 'pacenote-arrow-line' }), svg('path', { d: head, class: 'pacenote-arrow-head' }));
  return icon;
}

const el = (tag, className, text = '') => Object.assign(document.createElement(tag), { className, textContent: text });

export function createPacenoteHud() {
  const root = document.getElementById('pacenote-hud');
  let shown = null;

  return {
    /** @param {{pacenotes: object, indices: number[]} | null} view - notes to show, coming one first. */
    render(view) {
      const key = view?.indices.length ? `${view.indices.join(',')}|${view.indices.map((i) => JSON.stringify(view.pacenotes.notes[i])).join()}` : '';
      if (key === shown) return;
      shown = key;
      root.hidden = !key;
      if (!key) return root.replaceChildren();
      root.replaceChildren(
        ...view.indices.map((i) => {
          const note = view.pacenotes.notes[i];
          const tile = el('div', 'pacenote-tile');
          const gap = el('div', 'pacenote-gap', gapLabel(view.pacenotes, i));
          if (note.junction) {
            const fork = svg('svg', { viewBox: '0 0 20 24', class: 'pacenote-fork' });
            fork.append(svg('path', { d: FORK_PATH }));
            gap.append(fork);
          }
          tile.append(arrowIcon(note), el('div', 'pacenote-call', noteLabel(note)), gap);
          return tile;
        })
      );
    },
  };
}
