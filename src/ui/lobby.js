import { NET_STATUS_TEXT, CAN_USE_NETWORK, LOBBY_STORAGE_KEY, MULTIPLAYER_STORAGE_KEY } from '../config.js';
import { createVehiclePicker } from './vehiclePicker.js';
import { createVehiclePreview } from './vehiclePreview.js';
import { createVehicleColorPicker } from './vehicleColorPicker.js';
import { createTyreSetupPicker } from './tyreSetupPicker.js';
import { getVehicleColor, setVehicleColor, hasCustomVehicleColor } from '../lib/vehicleColors.js';
import { readSaveField, writeSaveField } from '../lib/saves.js';
import { isForbiddenPlayerName } from '../lib/playerNames.js';

// Saved name/colour/vehicle pick (the profile); prefills the lobby, and its vehicle starts new games.
function loadSavedChoices() {
  try {
    const raw = localStorage.getItem(LOBBY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.name !== 'string' || typeof parsed.color !== 'string') return null;
    // A forbidden name (e.g. saved in dev mode) counts as no profile, so the lobby asks again.
    if (isForbiddenPlayerName(parsed.name)) return null;
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

function loadMultiplayer() {
  try {
    return localStorage.getItem(MULTIPLAYER_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function saveMultiplayer(on) {
  try {
    localStorage.setItem(MULTIPLAYER_STORAGE_KEY, on ? '1' : '0');
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
  const netStatusEl = document.getElementById('net-status');
  const netModeToggle = document.getElementById('net-mode-toggle');
  const vehicleTabsEl = document.getElementById('vehicle-tabs');
  const vehicleListEl = document.getElementById('vehicle-list');
  const lobbyCancel = document.getElementById('lobby-cancel');

  let joined = false;
  let onProfileSaved = null;
  let multiplayer = CAN_USE_NETWORK && loadMultiplayer();

  // ---- Vehicle picker (category tabs + list) with a 3D preview + stats.
  const vehiclePreview = createVehiclePreview({
    canvas: document.getElementById('vehicle-preview'),
    statsEl: document.getElementById('vehicle-stats'),
  });
  const vehiclePicker = createVehiclePicker({
    tabsEl: vehicleTabsEl,
    listEl: vehicleListEl,
    onSelect: (id) => {
      vehiclePreview.setVehicle(id);
      showVehicleColor();
    },
  });
  // Paint edits are drafts until join/apply.
  const colorPicker = createVehicleColorPicker({ onChange: (color) => vehiclePreview.setColor(color) });
  document.getElementById('lobby-color').append(colorPicker.el);
  // Tyre edits too; shown once a game mode is picked (its garage keeps them).
  const tyrePicker = createTyreSetupPicker({ onChange: (setup) => vehiclePreview.setTyreSetup(setup) });
  document.getElementById('lobby-tyres').append(tyrePicker.el);

  const showVehicleColor = () => {
    colorPicker.show(vehiclePicker.getSelectedId());
    tyrePicker.show(vehiclePicker.getSelectedId());
  };

  function showLobby({ cancellable = joined } = {}) {
    colorPicker.discard();
    tyrePicker.discard();
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

  function setLobbyStatus(text) {
    lobbyStatus.textContent = text;
  }

  function setNetStatus(status) {
    netStatusEl.textContent = NET_STATUS_TEXT[status] ?? status;
    netStatusEl.dataset.status = status;
  }

  function showNetMode() {
    netModeToggle.textContent = multiplayer ? 'Go solo' : 'Go online';
    netModeToggle.disabled = !CAN_USE_NETWORK;
    netModeToggle.title = CAN_USE_NETWORK ? '' : 'No network in dev mode';
  }
  showNetMode();
  setNetStatus(multiplayer ? 'offline' : 'solo');

  netModeToggle.addEventListener('click', () => {
    if (!CAN_USE_NETWORK) return;
    multiplayer = !multiplayer;
    saveMultiplayer(multiplayer);
    showNetMode();
    if (!multiplayer) return net.disconnect();
    if (!joined) return setNetStatus('offline');
    const carManager = getCarManager();
    net.connect({ name: carManager.getLocalName(), color: carManager.getColor(), vehicleId: carManager.getVehicleId() });
  });

  net.onStatus((status) => {
    setNetStatus(status);
    if (lobbyEl.style.display !== 'none') setLobbyStatus(NET_STATUS_TEXT[status] ?? status);
  });

  async function joinRoom(name, color, vehicleId = vehiclePicker.getSelectedId()) {
    if (joined) return;
    lobbyJoin.disabled = true;
    if (multiplayer) {
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
    setNetStatus(!multiplayer ? 'solo' : net.isOnline() ? 'online' : 'offline');
    onJoined(color, vehicleId);
  }

  // Re-pick while already joined: apply live, no reconnect.
  function applyLivePick(name, color, vehicleId) {
    tyrePicker.commit(); // the respawn fits the garage's tyres
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
    colorPicker.commit();
    tyrePicker.commit();
    saveChoices(name, toHex(colorPicker.getColor()), vehicleId);
    saved = loadSavedChoices();
  }

  lobbyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = lobbyName.value.trim();
    if (!name || lobbyJoin.disabled) return;
    if (isForbiddenPlayerName(name)) {
      setLobbyStatus('This name is reserved, pick another one');
      lobbyName.focus();
      return;
    }
    const color = colorPicker.getColor();
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
    /** Joins with the profile name and the active mode's car, else the profile's, in its current paint. */
    joinSaved: () => {
      const vehicleId = readSaveField('vehicle')?.vehicleId ?? vehiclePicker.getSelectedId();
      return joinRoom(saved.name, getVehicleColor(vehicleId), vehicleId);
    },
  };
}
