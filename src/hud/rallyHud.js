// Rally HUD, top centre: stage title, big clock, start lights, status, next control,
// penalties, and the results card with its buttons. Patched per field, so it can be
// fed a fresh view every frame.

export function formatTime(ms) {
  if (ms == null) return '-:--.-';
  const sign = ms < 0 ? '-' : '';
  const tenths = Math.floor(Math.abs(ms) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${sign}${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
}

/** Signed delta, e.g. '+1.3' / '-0.8'. */
export const formatDelta = (ms) => `${ms > 0 ? '+' : ms < 0 ? '-' : '±'}${(Math.abs(ms) / 1000).toFixed(1)}`;

const el = (tag, className) => Object.assign(document.createElement(tag), { className });

/**
 * @param {Record<string, () => void>} actions - button id -> handler (retire, restart, pick, newRally, pickAgain, mainMenu).
 */
export function createRallyHud(actions) {
  const root = document.getElementById('rally-hud');
  const title = el('div', 'rally-title');
  const clock = el('div', 'rally-clock');
  const lights = el('div', 'rally-lights');
  const lamps = Array.from({ length: 5 }, () => lights.appendChild(el('span', 'rally-lamp')));
  const status = el('div', 'rally-status');
  const next = el('div', 'rally-next');
  const penalty = el('div', 'rally-penalty');
  const results = el('div', 'rally-results');
  const buttons = el('div', 'rally-buttons');
  root.append(title, clock, lights, status, next, penalty, results, buttons);

  const LABELS = { retire: 'Retire', restart: 'Restart stage', pick: 'Choose stage', newRally: 'Choose rally', pickAgain: 'Choose again', mainMenu: 'Main menu' };
  let shownButtons = '';
  let shownResults = null;

  const setText = (node, text) => {
    const value = text ?? '';
    if (node.textContent !== value) node.textContent = value;
    node.hidden = !value;
  };

  return {
    /**
     * @param {object | null} view - { title, clockMs, lights: {red, green} | null, status, next,
     *   penaltyMs, results: [label, value][] | null, buttons: string[] }; null hides the HUD.
     */
    render(view) {
      root.hidden = !view;
      if (!view) return;
      setText(title, view.title);
      setText(clock, view.clockMs == null ? '' : formatTime(view.clockMs));
      lights.hidden = !view.lights;
      if (view.lights) {
        lamps.forEach((lamp, i) => {
          lamp.classList.toggle('red', !view.lights.green && i < view.lights.red);
          lamp.classList.toggle('green', view.lights.green);
        });
      }
      setText(status, view.status);
      setText(next, view.next);
      setText(penalty, view.penaltyMs ? `Penalty +${formatTime(view.penaltyMs)}` : '');
      if (view.results !== shownResults) {
        shownResults = view.results;
        results.replaceChildren(
          ...(view.results ?? []).map(([label, value]) => {
            const row = el('div', 'rally-result-row');
            row.append(Object.assign(el('span'), { textContent: label }), Object.assign(el('span'), { textContent: value }));
            return row;
          })
        );
        results.hidden = !view.results?.length;
      }
      const key = (view.buttons ?? []).join(',');
      if (key !== shownButtons) {
        shownButtons = key;
        buttons.replaceChildren(
          ...(view.buttons ?? []).map((id) =>
            Object.assign(el('button'), { type: 'button', textContent: LABELS[id], onclick: () => actions[id]?.() })
          )
        );
        buttons.hidden = !key;
      }
    },
  };
}
