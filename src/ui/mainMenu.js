import { IS_DEV_MODE, LAUNCH_STORAGE_KEY } from '../config.js';
import { GAME_MODES, DEFAULT_GAME_MODE_ID, getGameMode } from '../app/gameModes.js';
import { getLatestModeId, getLastLaunch, getSaveInfo, clearSave, setActiveMode, getActiveModeId, isEditorSession, writeSaveField } from '../lib/saves.js';

// Main menu: Continue / Game mode / Settings. Picks the game mode (and so the save slot)
// before the world loads; Esc reopens it mid-game, where switching mode reloads the page
// so every subsystem starts from the new slot.

/** Mode (or menu screen) queued by a reload, consumed on the next load. */
function takePendingLaunch() {
  try {
    const pending = JSON.parse(sessionStorage.getItem(LAUNCH_STORAGE_KEY));
    sessionStorage.removeItem(LAUNCH_STORAGE_KEY);
    if (pending?.menu) return pending;
    const mode = getGameMode(pending?.modeId);
    return (pending?.editor ? mode?.editorAvailable : mode?.available) ? pending : null;
  } catch {
    return null;
  }
}

/** Reloads into the menu at `screen`, even in dev mode, e.g. Back out of a launch-time picker. */
export function reloadToMenu(screen = 'modes') {
  try {
    sessionStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify({ menu: screen }));
  } catch {}
  location.reload();
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
  let hooks = {}; // in game: { onOpen, onClose }

  function showScreen(name) {
    for (const el of screens) el.hidden = el.dataset.screen !== name;
    if (name === 'settings') settingsEl.append(settingsBodyEl);
    else settingsHome.parent.insertBefore(settingsBodyEl, settingsHome.next);
    if (name === 'root') renderRoot();
    if (name === 'modes') renderModes();
  }

  function open(screen = 'root') {
    if (menuEl.hidden) hooks.onOpen?.();
    menuEl.hidden = false;
    showScreen(screen);
  }

  function close() {
    showScreen('root');
    if (!menuEl.hidden) hooks.onClose?.();
    menuEl.hidden = true;
  }

  const continueModeId = () => (inGame ? getActiveModeId() : getLatestModeId());

  function renderRoot() {
    const mode = getGameMode(continueModeId());
    const playable = inGame || (mode?.available && getSaveInfo(mode.id));
    continueBtn.disabled = !playable;
    continueLabel.textContent = !playable ? '' : inGame && isEditorSession() ? `${mode.label} editor` : mode.label;
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
        const starts = (mode.starts ?? [{ label: 'Start new' }]).map(({ id, label, available = true }) => {
          const startNew = document.createElement('button');
          startNew.type = 'button';
          startNew.textContent = label;
          startNew.disabled = !mode.available || !available;
          startNew.addEventListener('click', () => launch(mode.id, true, false, id));
          return startNew;
        });
        actions.append(continueMode, ...starts);
        if (mode.editor) {
          const editor = document.createElement('button');
          editor.type = 'button';
          editor.textContent = 'Editor';
          editor.disabled = !mode.editorAvailable;
          editor.addEventListener('click', () => launch(mode.id, false, true));
          actions.append(editor);
        }
        card.append(title, body, actions);
        return card;
      })
    );
  }

  function launch(modeId, fresh, editor = false, startId = null) {
    if (fresh && getSaveInfo(modeId) && !window.confirm(`Start a new ${getGameMode(modeId).label} game? The saved one will be lost.`)) return;
    if (inGame) {
      if (modeId === getActiveModeId() && !fresh && editor === isEditorSession()) return close();
      // The slot is cleared after the reload, so this page's last save can't refill it.
      try {
        sessionStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify({ modeId, fresh, editor, startId }));
      } catch {
        return;
      }
      location.reload();
      return;
    }
    start(modeId, fresh, editor, startId);
  }

  function start(modeId, fresh, editor = false, startId = null) {
    if (fresh) clearSave(modeId, getGameMode(modeId)?.keepOnNewGame);
    setActiveMode(modeId, editor);
    if (fresh && startId) writeSaveField('start', startId);
    close();
    resolveLaunch?.();
  }

  menuEl.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'continue') launch(continueModeId(), false, inGame && isEditorSession());
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
    openSettings: () => open('settings'),
    /** Resolves once a mode is active: dev mode and mid-game switches skip the menu. */
    async waitForLaunch() {
      const pending = takePendingLaunch();
      if (pending && !pending.menu) return start(pending.modeId, pending.fresh, pending.editor, pending.startId);
      if (IS_DEV_MODE && !pending) {
        // Back into the last session, editor included.
        const last = getLastLaunch();
        const mode = getGameMode(last?.modeId);
        if (last?.editor ? mode?.editorAvailable : mode?.available) return start(mode.id, false, last.editor);
        const latest = getGameMode(getLatestModeId());
        return start(latest?.available ? latest.id : DEFAULT_GAME_MODE_ID, false);
      }
      await ensureProfile();
      await new Promise((resolve) => {
        resolveLaunch = resolve;
        open(pending?.menu);
      });
    },
    /**
     * From now on Esc toggles the menu and Continue resumes.
     * @param {{onOpen?: () => void, onClose?: () => void}} [inGameHooks] - run as the menu covers / uncovers the game.
     */
    setInGame(inGameHooks = {}) {
      hooks = inGameHooks;
      inGame = true;
      menuEl.classList.add('in-game');
    },
  };
}
