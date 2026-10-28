// Pacenote strip under the rally clock: the next few notes as tiles, the coming one first -
// an arrow bent by the grade, the call (L4, R2, Straight) and what follows it (a distance,
// into, and), with a fork icon at junctions. Surface calls show a swatch of the surface instead of the arrow.

import { noteLabel, gapLabel } from '../lib/rally/pacenoteCalls.js';
import { arrowPaths, ARROW_VIEWBOX, FORK_PATH } from '../lib/rally/pacenoteIcon.js';
import { STAGE_SURFACES } from '../lib/rally/stageSurfaces.js';

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

const ENTER = { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' };
const LEAVE = { duration: 320, easing: 'cubic-bezier(0.5, 0, 0.8, 0.6)', fill: 'forwards' };
const SLIDE = { duration: 300, easing: 'cubic-bezier(0.25, 0.8, 0.3, 1)' };
const ENTER_DX = 56;
const LEAVE_DX = -72;

function gradeClass(note) {
  if (note.surface || note.dir === 'S') return '';
  if (note.grade === 1) return ' grade-1';
  return note.grade <= 3 ? ' grade-2-3' : '';
}

function buildTile(pacenotes, i) {
  const note = pacenotes.notes[i];
  const tile = el('div', `pacenote-tile${gradeClass(note)}`);
  const gap = el('div', 'pacenote-gap', gapLabel(pacenotes, i));
  if (note.junction) {
    const fork = svg('svg', { viewBox: '0 0 20 24', class: 'pacenote-fork' });
    fork.append(svg('path', { d: FORK_PATH }));
    gap.append(fork);
  }
  const icon = note.surface ? el('div', 'pacenote-surface') : arrowIcon(note);
  if (note.surface) icon.style.background = STAGE_SURFACES[note.surface].color;
  tile.append(icon, el('div', 'pacenote-call', noteLabel(note)), gap);
  return tile;
}

export function createPacenoteHud() {
  const root = document.getElementById('pacenote-hud');
  /** key -> tile of the notes on screen, in order; leaving tiles are dropped from it. */
  let live = new Map();
  let shown = '';

  const hideIfEmpty = () => {
    if (!root.children.length) root.hidden = true;
  };

  return {
    /** @param {{pacenotes: object, indices: number[]} | null} view - notes to show, coming one first. */
    render(view) {
      const keys = (view?.indices ?? []).map((i) => `${i}|${JSON.stringify(view.pacenotes.notes[i])}`);
      const key = keys.join(',');
      if (key === shown) return;
      shown = key;

      // FLIP: measure where every tile is drawn now (mid-animation included), relayout, then animate from there.
      const before = new Map([...live].map(([k, tile]) => [k, tile.getBoundingClientRect()]));
      const leaving = [...live].filter(([k]) => !keys.includes(k));
      const next = new Map();
      keys.forEach((k, n) => {
        const tile = live.get(k) ?? buildTile(view.pacenotes, view.indices[n]);
        tile.getAnimations().forEach((a) => a.cancel());
        tile.classList.toggle('current', n === 0);
        next.set(k, tile);
      });
      for (const [, tile] of leaving) tile.getAnimations().forEach((a) => a.cancel());
      if (next.size) root.hidden = false;
      // Live tiles first in order; leaving ones are taken out of the flow and stay put while they fade.
      root.prepend(...next.values());

      const rootRect = root.getBoundingClientRect();
      for (const [k, tile] of leaving) {
        const r = before.get(k);
        tile.classList.add('leaving');
        Object.assign(tile.style, { left: `${r.left - rootRect.left}px`, top: `${r.top - rootRect.top}px` });
        tile
          .animate([{ transform: 'none' }, { transform: `translateX(${LEAVE_DX}px)`, opacity: 0 }], LEAVE)
          .finished.then(() => {
            tile.remove();
            hideIfEmpty();
          }, () => {});
      }
      for (const [k, tile] of next) {
        const r = before.get(k);
        if (!r) {
          tile.animate([{ transform: `translateX(${ENTER_DX}px)`, opacity: 0 }, { transform: 'none' }], ENTER);
          continue;
        }
        const now = tile.getBoundingClientRect();
        const dx = r.left - now.left;
        const dy = r.top - now.top;
        if (Math.abs(dx) + Math.abs(dy) > 0.5) tile.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], SLIDE);
      }
      live = next;
      hideIfEmpty();
    },
  };
}
