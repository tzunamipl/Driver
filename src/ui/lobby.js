import { DEFAULT_BODY_COLOR, NET_STATUS_TEXT, IS_DEV_MODE, CAN_USE_NETWORK, LOBBY_STORAGE_KEY } from '../config.js';
import { clearCarState } from '../lib/carState.js';
import { DEFAULT_VEHICLE_ID } from '../lib/vehicles/index.js';
import { createVehiclePicker } from './vehiclePicker.js';

// Saved name/colour/vehicle pick (cleared by "Reset saved info").
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

function saveChoices(name, color, vehicleId) {
  try {
    localStorage.setItem(LOBBY_STORAGE_KEY, JSON.stringify({ name, color, vehicleId }));
  } catch {
    // Storage unavailable: just don't persist.
  }
}

// Lobby: name/colour/vehicle form, join flow and network status.

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../lib/net.js').createNet>} deps.net
 * @param {import('../app/carManager.js').ReturnType} deps.carManager
 * @param {(color: number, vehicleId: string) => void} deps.onJoined - spawn the car after joining.
 * @param {() => void} [deps.onReset] - after a mid-drive re-pick respawned the car.
 */
export function createLobby({ net, carManager, onJoined, onReset, originChain }) {
  const lobbyEl = document.getElementById('lobby');
  // Dev mode never shows the prompt (see joinRoom).
  if (IS_DEV_MODE) lobbyEl.style.display = 'none';
  const lobbyForm = document.getElementById('lobby-form');
  const lobbyName = document.getElementById('lobby-name');
  const lobbyJoin = document.getElementById('lobby-join');
  const lobbyStatus = document.getElementById('lobby-status');
  const lobbyColor = document.getElementById('lobby-color');
  const netStatusEl = document.getElementById('net-status');
  const vehicleTabsEl = document.getElementById('vehicle-tabs');
  const vehicleListEl = document.getElementById('vehicle-list');

  let joined = false;

  // ---- Vehicle picker (category tabs + list), built from the registry.
  const vehiclePicker = createVehiclePicker({ tabsEl: vehicleTabsEl, listEl: vehicleListEl });

  // Prefill a saved pick and hide the prompt; tryAutoJoin uses it.
  const saved = loadSavedChoices();
  if (saved) {
    lobbyName.value = saved.name;
    lobbyColor.value = saved.color;
    if (saved.vehicleId) vehiclePicker.select(saved.vehicleId);
    lobbyEl.style.display = 'none';
  }

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

    carManager.setLocalName(name.slice(0, 16));
    saveChoices(name, lobbyColor.value, vehicleId);
    joined = true;
    lobbyEl.style.display = 'none';
    netStatusEl.hidden = false;
    setNetStatus(CAN_USE_NETWORK && net.isOnline() ? 'online' : 'offline');
    onJoined(color, vehicleId);
  }

  // Re-pick while already joined: apply live, no reconnect.
  function applyLivePick(name, color, vehicleId) {
    carManager.setLocalName(name.slice(0, 16));
    carManager.spawnLocalCar(color, vehicleId);
    net.setName(name);
    net.setColor(color);
    net.setVehicleId(vehicleId);
    saveChoices(name, lobbyColor.value, vehicleId);
    lobbyEl.style.display = 'none';
    onReset?.();
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
      joinRoom(name, color, vehicleId);
    }
  });

  window.addEventListener('pagehide', () => {
    if (joined) net.publishLeave();
  });

  function resetSavedChoices() {
    try {
      localStorage.removeItem(LOBBY_STORAGE_KEY);
    } catch {
      // Storage unavailable - nothing to clear.
    }
    clearCarState();
    lobbyName.value = '';
    lobbyColor.value = `#${DEFAULT_BODY_COLOR.toString(16).padStart(6, '0')}`;
    vehiclePicker.select(DEFAULT_VEHICLE_ID);
  }

  // Help-menu reset: clear the saved pick and reopen a blank form.
  const resetChoicesBtn = document.getElementById('hud-reset-choices');
  resetChoicesBtn?.addEventListener('click', () => {
    resetSavedChoices();
    lobbyJoin.disabled = false;
    lobbyJoin.textContent = joined ? 'Apply' : 'Drive in';
    lobbyEl.style.display = '';
    setLobbyStatus(joined ? 'Pick a new name/color/vehicle' : '');
    lobbyName.focus();
  });

  return {
    isJoined: () => joined,
    joinRoom,
    setStatus: setLobbyStatus,
    enableJoinButton: () => {
      lobbyJoin.disabled = false;
    },
    resetSavedChoices,
    // Auto-join with a saved pick; returns whether it did.
    tryAutoJoin: () => {
      if (!saved) return false;
      joinRoom(saved.name, selectedColor(), vehiclePicker.getSelectedId());
      return true;
    },
  };
}
