import { DEFAULT_BODY_COLOR, NET_STATUS_TEXT, CAN_USE_NETWORK, LOBBY_STORAGE_KEY } from '../config.js';
import { createVehiclePicker } from './vehiclePicker.js';
import { createVehiclePreview } from './vehiclePreview.js';
import { getVehicleColor, setVehicleColor, defaultVehicleColor, hasCustomVehicleColor } from '../lib/vehicleColors.js';
import { readSaveField, writeSaveField } from '../lib/saves.js';

// Saved name/colour/vehicle pick (the profile); prefills the lobby, and its vehicle starts new games.
function loadSavedChoices() {
  try {
    const raw = localStorage.getItem(LOBBY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.name !== 'string' || typeof parsed.color !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The profile's player name, or null before it's set. */
export const loadProfileName = () => loadSavedChoices()?.name ?? null;

/** The profile's default vehicle, or null. */
export const loadProfileVehicleId = () => loadSavedChoices()?.vehicleId ?? null;

function saveChoices(name, color, vehicleId) {
  try {
    localStorage.setItem(LOBBY_STORAGE_KEY, JSON.stringify({ name, color, vehicleId }));
  } catch {
    // Storage unavailable: just don't persist.
  }
}

const toHex = (n) => `#${n.toString(16).padStart(6, '0')}`;

// Lobby: name/colour/vehicle form, join flow and network status. Before joining
// it only edits the profile; once in a game it re-picks the car live.

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../lib/net.js').createNet>} deps.net
 * @param {() => import('../app/carManager.js').ReturnType} deps.getCarManager - created after the menu.
 * @param {(color: number, vehicleId: string) => void} deps.onJoined - spawn the car after joining.
 * @param {() => void} [deps.onReset] - after a mid-drive re-pick respawned the car.
 */
export function createLobby({ net, getCarManager, onJoined, onReset, originChain }) {
  const lobbyEl = document.getElementById('lobby');
  const lobbyForm = document.getElementById('lobby-form');
  const lobbyName = document.getElementById('lobby-name');
  const lobbyJoin = document.getElementById('lobby-join');
  const lobbyStatus = document.getElementById('lobby-status');
  const lobbyColor = document.getElementById('lobby-color');
  const netStatusEl = document.getElementById('net-status');
  const vehicleTabsEl = document.getElementById('vehicle-tabs');
  const vehicleListEl = document.getElementById('vehicle-list');
  const lobbyCancel = document.getElementById('lobby-cancel');
  const lobbyColorReset = document.getElementById('lobby-color-reset');

  let joined = false;
  let onProfileSaved = null;
  // Colours edited in this lobby session, per vehicle id; stored only on join/apply.
  const draftColors = new Map();

  // ---- Vehicle picker (category tabs + list) with a 3D preview + stats.
  const vehiclePreview = createVehiclePreview({
    canvas: document.getElementById('vehicle-preview'),
    statsEl: document.getElementById('vehicle-stats'),
  });
  const vehiclePicker = createVehiclePicker({
    tabsEl: vehicleTabsEl,
    listEl: vehicleListEl,
    onSelect: (id) => {
      // A newly picked vehicle starts in its own paint; repaint before joining to keep another.
      draftColors.set(id, defaultVehicleColor(id));
      vehiclePreview.setVehicle(id);
      showVehicleColor();
    },
  });
  lobbyColor.addEventListener('input', () => {
    draftColors.set(vehiclePicker.getSelectedId(), selectedColor());
    showVehicleColor();
  });
  lobbyColorReset.addEventListener('click', () => {
    const id = vehiclePicker.getSelectedId();
    draftColors.set(id, defaultVehicleColor(id));
    showVehicleColor();
  });

  /** Shows the selected vehicle's (draft or stored) colour in the input and preview. */
  function showVehicleColor() {
    const id = vehiclePicker.getSelectedId();
    const color = draftColors.get(id) ?? getVehicleColor(id);
    lobbyColor.value = toHex(color);
    lobbyColorReset.disabled = color === defaultVehicleColor(id);
    vehiclePreview.setColor(color);
  }

  function commitDraftColors() {
    for (const [id, color] of draftColors) setVehicleColor(id, color);
    draftColors.clear();
  }

  function showLobby({ cancellable = joined } = {}) {
    draftColors.clear();
    lobbyEl.style.display = '';
    lobbyCancel.hidden = !cancellable;
    lobbyJoin.disabled = false;
    lobbyJoin.textContent = joined ? 'Apply' : 'OK';
    setLobbyStatus('');
    vehiclePreview.start();
  }

  function hideLobby() {
    lobbyEl.style.display = 'none';
    vehiclePreview.stop();
  }

  // Prefill a saved pick.
  let saved = loadSavedChoices();
  if (saved) {
    lobbyName.value = saved.name;
    if (saved.vehicleId) vehiclePicker.select(saved.vehicleId);
    // Carry over a colour picked before colours were per vehicle.
    const id = vehiclePicker.getSelectedId();
    if (saved.color !== '#ffffff' && !hasCustomVehicleColor(id)) {
      const legacy = Number.parseInt(saved.color.replace('#', ''), 16);
      if (Number.isInteger(legacy)) setVehicleColor(id, legacy);
    }
  }
  vehiclePreview.setVehicle(vehiclePicker.getSelectedId());
  showVehicleColor();

  function selectedColor() {
    const hex = String(lobbyColor.value || '').replace('#', '');
    const n = Number.parseInt(hex, 16);
    return Number.isInteger(n) && n >= 0 && n <= 0xffffff ? n : DEFAULT_BODY_COLOR;
  }

  function setLobbyStatus(text) {
    lobbyStatus.textContent = text;
  }

  function setNetStatus(status) {
    netStatusEl.textContent = NET_STATUS_TEXT[status] ?? status;
    netStatusEl.dataset.status = status;
  }

  net.onStatus((status) => {
    setNetStatus(status);
    if (lobbyEl.style.display !== 'none') setLobbyStatus(NET_STATUS_TEXT[status] ?? status);
  });

  async function joinRoom(name, color, vehicleId = vehiclePicker.getSelectedId()) {
    if (joined) return;
    lobbyJoin.disabled = true;
    if (CAN_USE_NETWORK) {
      setLobbyStatus('Connecting…');
      try {
        await net.connect({ name, color, vehicleId });
        await originChain();
      } catch (err) {
        console.warn('Room connect failed', err);
      }
    }

    getCarManager().setLocalName(name.slice(0, 16));
    writeSaveField('vehicle', { vehicleId, color });
    joined = true;
    hideLobby();
    netStatusEl.hidden = false;
    setNetStatus(CAN_USE_NETWORK && net.isOnline() ? 'online' : 'offline');
    onJoined(color, vehicleId);
  }

  // Re-pick while already joined: apply live, no reconnect.
  function applyLivePick(name, color, vehicleId) {
    const carManager = getCarManager();
    carManager.setLocalName(name.slice(0, 16));
    carManager.spawnLocalCar(color, vehicleId);
    net.setName(name);
    net.setColor(color);
    net.setVehicleId(vehicleId);
    saveProfile(name, vehicleId);
    writeSaveField('vehicle', { vehicleId, color });
    hideLobby();
    onReset?.();
  }

  function saveProfile(name, vehicleId) {
    commitDraftColors();
    saveChoices(name, lobbyColor.value, vehicleId);
    saved = loadSavedChoices();
  }

  lobbyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = lobbyName.value.trim();
    if (!name || lobbyJoin.disabled) return;
    const color = selectedColor();
    const vehicleId = vehiclePicker.getSelectedId();
    if (joined) {
      applyLivePick(name, color, vehicleId);
    } else {
      saveProfile(name, vehicleId);
      hideLobby();
      onProfileSaved?.();
      onProfileSaved = null;
    }
  });

  window.addEventListener('pagehide', () => {
    if (joined) net.publishLeave();
  });

  // Settings-menu "Change name/vehicle": reopen the form prefilled with the current pick.
  const changeChoicesBtn = document.getElementById('hud-change-choices');
  changeChoicesBtn?.addEventListener('click', () => {
    if (joined) {
      // The debug picker can change the vehicle live, so read the car, not storage.
      const carManager = getCarManager();
      lobbyName.value = carManager.getLocalName() || lobbyName.value;
      vehiclePicker.select(carManager.getVehicleId());
    }
    vehiclePreview.setVehicle(vehiclePicker.getSelectedId());
    showLobby({ cancellable: true });
    showVehicleColor();
    lobbyName.focus();
  });

  lobbyCancel.addEventListener('click', hideLobby);

  return {
    isJoined: () => joined,
    joinRoom,
    /** Resolves once a name is saved, asking for one first if there's none yet. */
    ensureProfile: () =>
      new Promise((resolve) => {
        if (saved) return resolve();
        onProfileSaved = resolve;
        showLobby({ cancellable: false });
        lobbyName.focus();
      }),
    /** Joins with the profile name and the active mode's car, else the profile's. */
    joinSaved: () => {
      const vehicle = readSaveField('vehicle');
      const vehicleId = vehicle?.vehicleId ?? vehiclePicker.getSelectedId();
      return joinRoom(saved.name, vehicle?.color ?? getVehicleColor(vehicleId), vehicleId);
    },
  };
}
