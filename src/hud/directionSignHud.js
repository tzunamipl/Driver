// Top-centre copy of the direction sign the car is driving up to
// (directionSigns.js), so it can be read at speed.

import { boardColor, kmText } from '../lib/directionSigns.js';

const RANGE_M = 120;
const AHEAD_COS = Math.cos((40 * Math.PI) / 180); // sign within this angle of the car's heading...
const FACING_COS = Math.cos((50 * Math.PI) / 180); // ...and turned towards the car
const LINGER_S = 2; // kept up after passing it, through the junction

/**
 * @param {HTMLElement} el
 * @param {object} [opts]
 * @param {boolean} [opts.allowed] - false: never shown this session (game mode), whatever setEnabled says.
 */
export function createDirectionSignHud(el, { allowed = true } = {}) {
  let enabled = allowed;
  let shown = null; // item
  let lingered = 0;

  function render(item) {
    el.replaceChildren(
      ...(item?.boards ?? []).map((board) => {
        const row = document.createElement('div');
        row.className = `dsign-board dsign-${board.dir}`;
        const { bg, fg } = boardColor(board.cls);
        row.style.setProperty('--dsign-bg', bg);
        row.style.setProperty('--dsign-fg', fg);
        const name = document.createElement('span');
        name.className = 'dsign-name';
        name.textContent = board.dir === 'straight' ? `↑ ${board.name}` : board.name;
        const km = document.createElement('span');
        km.className = 'dsign-km';
        km.textContent = kmText(board);
        row.append(name, km);
        return row;
      })
    );
    el.classList.toggle('visible', !!item);
  }

  return {
    /**
     * @param {number} dt
     * @param {{ item: object, object: import('three').Object3D }[]} signs - standing direction signs
     * @param {number} x - car position
     * @param {number} z
     * @param {number} fx - car heading (unit, horizontal)
     * @param {number} fz
     */
    update(dt, signs, x, z, fx, fz) {
      let best = null;
      let bestDist = RANGE_M;
      if (enabled) {
        for (const { item, object } of signs) {
          const dx = object.position.x - x;
          const dz = object.position.z - z;
          const dist = Math.hypot(dx, dz);
          if (dist >= bestDist || (dx * fx + dz * fz) / dist < AHEAD_COS) continue;
          if (-(Math.sin(item.yaw) * fx + Math.cos(item.yaw) * fz) < FACING_COS) continue;
          best = item;
          bestDist = dist;
        }
      }
      if (best) lingered = 0;
      else if (shown && enabled && (lingered += dt) < LINGER_S) best = shown;
      if (best !== shown) {
        shown = best;
        render(best);
      }
    },

    setEnabled(value) {
      enabled = allowed && value;
    },
  };
}
