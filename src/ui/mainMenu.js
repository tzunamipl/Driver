import { IS_DEV_MODE, LAUNCH_STORAGE_KEY } from '../config.js';
import { GAME_MODES, DEFAULT_GAME_MODE_ID, getGameMode } from '../app/gameModes.js';
import { getLatestModeId, getSaveInfo, clearSave, setActiveMode, getActiveModeId } from '../lib/saves.js';

// Main menu: Continue / Game mode / Settings. Picks the game mode (and so the save slot)
// before the world loads; Esc reopens it mid-game, where switching mode reloads the page
// so every subsystem starts from the new slot.

/** Mode queued by a mid-game switch, consumed on the next load. */
function takePendingLaunch() {
  try {
    const pending = JSON.parse(sessionStorage.getItem(LAUNCH_STORAGE_KEY));
    sessionStorage.removeItem(LAUNCH_STORAGE_KEY);
    return getGameMode(pending?.modeId)?.available ? pending : null;
  } catch {
    return null;
  }
}

const formatDate = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/**
 * @param {object} deps
 * @param {() => Promise<void>} deps.ensureProfile - lobby name/vehicle prompt for first-time players.
 * @param {HTMLElement} deps.settingsBodyEl - the in-game Settings window body, borrowed by the Settings screen.
 */
export function createMainMenu({ ensureProfile, settingsBodyEl }) {
  const menuEl = document.getElementById('main-menu');
  const screens = [...menuEl.querySelectorAll('.menu-screen')];
  const continueBtn = menuEl.querySelector('[data-action="continue"]');
  const continueLabel = menuEl.querySelector('.menu-continue-mode');
  const modesEl = document.getElementById('menu-modes');
  const settingsEl = document.getElementById('menu-settings');
  const settingsHome = { parent: settingsBodyEl.parentElement, next: settingsBodyEl.nextSibling };

  let inGame = false;
  let resolveLaunch = null;

  function showScreen(name) {
    for (const el of screens) el.hidden = el.dataset.screen !== name;
    if (name === 'settings') settingsEl.append(settingsBodyEl);
    else settingsHome.parent.insertBefore(settingsBodyEl, settingsHome.next);
    if (name === 'root') renderRoot();
    if (name === 'modes') renderModes();
  }

  function open(screen = 'root') {
    menuEl.hidden = false;
    showScreen(screen);
  }

  function close() {
    showScreen('root');
    menuEl.hidden = true;
  }

  const continueModeId = () => (inGame ? getActiveModeId() : getLatestModeId());

  function renderRoot() {
    const mode = getGameMode(continueModeId());
    const playable = mode?.available && (inGame || getSaveInfo(mode.id));
    continueBtn.disabled = !playable;
    continueLabel.textContent = playable ? mode.label : '';
  }

  function renderModes() {
    modesEl.replaceChildren(
      ...GAME_MODES.map((mode) => {
        const info = mode.available ? getSaveInfo(mode.id) : null;
        const card = document.createElement('div');
        card.className = 'menu-mode';
        card.classList.toggle('unavailable', !mode.available);
        card.classList.toggle('active', inGame && mode.id === getActiveModeId());
        const title = document.createElement('div');
        title.className = 'menu-mode-title';
        title.textContent = mode.label;
        const body = document.createElement('div');
        body.className = 'menu-mode-body';
        const blurb = document.createElement('p');
        blurb.textContent = mode.blurb ?? '';
        const status = document.createElement('p');
        status.className = 'menu-mode-status';
        status.textContent = !mode.available
          ? 'Coming soon'
          : info
            ? `${info.savedAt ? `Last played ${formatDate(info.savedAt)}\n` : ''}${info.odoKm.toFixed(1)} km driven`
            : 'No save yet';
        body.append(blurb, status);
        const actions = document.createElement('div');
        actions.className = 'menu-mode-actions';
        const continueMode = document.createElement('button');
        continueMode.type = 'button';
        continueMode.textContent = mode.continueLabel ?? 'Continue';
        continueMode.disabled = !info;
        continueMode.addEventListener('click', () => launch(mode.id, false));
        const starts = (mode.starts ?? [{ label: 'Start new' }]).map(({ label }) => {
          const startNew = document.createElement('button');
          startNew.type = 'button';
          startNew.textContent = label;
          startNew.disabled = !mode.available;
          startNew.addEventListener('click', () => launch(mode.id, true));
          return startNew;
        });
        actions.append(continueMode, ...starts);
        if (mode.editor) {
          const editor = document.createElement('button');
          editor.type = 'button';
          editor.textContent = 'Editor';
          editor.disabled = !mode.editorAvailable;
          actions.append(editor);
        }
        card.append(title, body, actions);
        return card;
      })
    );
  }

  function launch(modeId, fresh) {
    if (fresh && getSaveInfo(modeId) && !window.confirm(`Start a new ${getGameMode(modeId).label} game? The saved one will be lost.`)) return;
    if (inGame) {
      if (modeId === getActiveModeId() && !fresh) return close();
      // The slot is cleared after the reload, so this page's last save can't refill it.
      try {
        sessionStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify({ modeId, fresh }));
      } catch {
        return;
      }
      location.reload();
      return;
    }
    start(modeId, fresh);
  }

  function start(modeId, fresh) {
    if (fresh) clearSave(modeId);
    setActiveMode(modeId);
    close();
    resolveLaunch?.();
  }

  menuEl.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'continue') launch(continueModeId(), false);
    else if (action === 'modes' || action === 'settings') showScreen(action);
    else if (action === 'back') showScreen('root');
  });

  document.getElementById('hud-main-menu').addEventListener('click', () => open());

  // Capture phase: while open, game keys (drive, camera, horn) never reach their listeners.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!inGame) return;
      if (!menuEl.hidden && e.code !== 'Escape') return e.stopImmediatePropagation();
      if (e.code !== 'Escape' || e.repeat) return;
      if (document.getElementById('lobby').style.display !== 'none') return;
      if (menuEl.hidden) open();
      else if (!screens.find((el) => el.dataset.screen === 'root').hidden) close();
      else showScreen('root');
    },
    { capture: true }
  );

  return {
    /** Resolves once a mode is active: dev mode and mid-game switches skip the menu. */
    async waitForLaunch() {
      const pending = takePendingLaunch();
      if (pending) return start(pending.modeId, pending.fresh);
      if (IS_DEV_MODE) {
        const latest = getGameMode(getLatestModeId());
        return start(latest?.available ? latest.id : DEFAULT_GAME_MODE_ID, false);
      }
      await ensureProfile();
      await new Promise((resolve) => {
        resolveLaunch = resolve;
        open();
      });
    },
    /** From now on Esc toggles the menu and Continue resumes. */
    setInGame() {
      inGame = true;
      menuEl.classList.add('in-game');
    },
  };
}
