import { readSaveField, writeSaveField } from '../lib/saves.js';

// Debug-view panels fold down to their title on click (state kept in the save file).

/** Each panel needs an id and a `.debug-fold-title` child that becomes the toggle. */
export function setupDebugFolds(panels) {
  const saved = readSaveField('debugFolded');
  const folded = saved && typeof saved === 'object' ? { ...saved } : {};
  for (const panel of panels) {
    const title = panel?.querySelector('.debug-fold-title');
    if (!title) continue;
    title.setAttribute('role', 'button');
    const apply = () => {
      panel.classList.toggle('debug-folded', !!folded[panel.id]);
      title.setAttribute('aria-expanded', folded[panel.id] ? 'false' : 'true');
    };
    title.addEventListener('click', () => {
      folded[panel.id] = !folded[panel.id];
      writeSaveField('debugFolded', folded);
      apply();
    });
    apply();
  }
}
