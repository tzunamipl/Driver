import { IS_DEV_MODE, LAUNCH_STORAGE_KEY } from '../config.js';
import { GAME_MODES, DEFAULT_GAME_MODE_ID, getGameMode, getStart, keepsProgress } from '../app/gameModes.js';
import { getLatest, getLastLaunch, getSaveInfo, clearSave, setActiveMode, getActiveModeId, getActiveStartId, isEditorSession } from '../lib/saves.js';

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

/** Menu text for a save: the game's own status (e.g. rally progress), else the distance driven. */
const describeSave = (info) =>
  `${info.status ?? `${info.odoKm.toFixed(1)} km driven`}${info.savedAt ? `\nLast played ${formatDate(info.savedAt)}` : ''}`;

const button = (label, disabled, onClick) => {
  const el = Object.assign(document.createElement('button'), { type: 'button', textContent: label, disabled });
  el.addEventListener('click', onClick);
  return el;
};

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

  /** The game Continue resumes: { modeId, startId, editor }. */
  const continueTarget = () =>
    inGame ? { modeId: getActiveModeId(), startId: getActiveStartId(), editor: isEditorSession() } : { ...getLatest(), editor: false };

  function renderRoot() {
    const { modeId, startId, editor } = continueTarget();
    const mode = getGameMode(modeId);
    const playable = inGame || (mode?.available && getSaveInfo(modeId, startId));
    const name = getStart(mode, startId)?.name;
    continueBtn.disabled = !playable;
    continueLabel.textContent = !playable ? '' : editor ? `${mode.label} editor` : name ? `${mode.label} · ${name}` : mode.label;
  }

  /** Mode card: the blurb, each saving game's progress, then Resume / New buttons per start. */
  function renderModes() {
    modesEl.replaceChildren(
      ...GAME_MODES.map((mode) => {
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
        body.append(blurb);
        const actions = document.createElement('div');
        actions.className = 'menu-mode-actions';
        const status = (text) => body.append(Object.assign(document.createElement('p'), { className: 'menu-mode-status', textContent: text }));
        if (!mode.available) status('Coming soon');
        // One Resume (or Continue) per game that saves: a mode without starts is one game.
        for (const st of mode.starts ? mode.starts.filter((s) => s.saves) : [null]) {
          const playable = mode.available && (st?.available ?? true);
          const info = playable ? getSaveInfo(mode.id, st?.id) : null;
          const text = !playable ? 'Coming soon' : info ? describeSave(info) : 'No save yet';
          if (mode.available) status(st ? `${st.name}: ${text}` : text);
          actions.append(button(st ? `Resume ${st.name.toLowerCase()}` : 'Continue', !info, () => launch(mode.id, st?.id ?? null, false)));
        }
        for (const st of mode.starts ?? [null]) {
          const label = st ? `New ${st.name.toLowerCase()}` : 'Start new';
          actions.append(button(label, !mode.available || !(st?.available ?? true), () => launch(mode.id, st?.id ?? null, true)));
        }
        if (mode.editor) actions.append(button('Editor', !mode.editorAvailable, () => launch(mode.id, null, false, true)));
        card.append(title, body, actions);
        return card;
      })
    );
  }

  function launch(modeId, startId, fresh, editor = false) {
    const mode = getGameMode(modeId);
    const what = getStart(mode, startId)?.name.toLowerCase() ?? `${mode.label} game`;
    if (fresh && getSaveInfo(modeId, startId) && !window.confirm(`Start a new ${what}? The saved one will be lost.`)) return;
    if (inGame) {
      const same = modeId === getActiveModeId() && editor === isEditorSession() && (editor || startId === getActiveStartId());
      if (same && !fresh) return close();
      // The slot is cleared after the reload, so this page's last save can't refill it.
      try {
        sessionStorage.setItem(LAUNCH_STORAGE_KEY, JSON.stringify({ modeId, startId, fresh, editor }));
      } catch {
        return;
      }
      location.reload();
      return;
    }
    start(modeId, startId, fresh, editor);
  }

  function start(modeId, startId, fresh, editor = false) {
    const mode = getGameMode(modeId);
    if (fresh) clearSave(modeId, startId, mode?.keepOnNewGame);
    setActiveMode(modeId, { editor, startId, keepsProgress: keepsProgress(mode, startId) });
    close();
    resolveLaunch?.();
  }

  menuEl.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'continue') {
      const { modeId, startId, editor } = continueTarget();
      launch(modeId, startId, false, editor);
    }
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
    open: () => open(),
    openSettings: () => open('settings'),
    /** Resolves once a mode is active: dev mode and mid-game switches skip the menu. */
    async waitForLaunch() {
      const pending = takePendingLaunch();
      if (pending && !pending.menu) return start(pending.modeId, pending.startId ?? null, pending.fresh, pending.editor);
      if (IS_DEV_MODE && !pending) {
        // Back into the last session, editor included.
        const last = getLastLaunch();
        const mode = getGameMode(last?.modeId);
        if (last?.editor ? mode?.editorAvailable : mode?.available) return start(mode.id, last.startId ?? null, false, last.editor);
        const latest = getLatest();
        if (getGameMode(latest?.modeId)?.available) return start(latest.modeId, latest.startId, false);
        return start(DEFAULT_GAME_MODE_ID, null, false);
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
