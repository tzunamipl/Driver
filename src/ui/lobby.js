import { DEFAULT_BODY_COLOR, NET_STATUS_TEXT, IS_DEV_MODE, CAN_USE_NETWORK, LOBBY_STORAGE_KEY } from '../config.js';
import { clearCarState } from '../lib/carState.js';
import { DEFAULT_VEHICLE_ID } from '../lib/vehicles/index.js';
import { createVehiclePicker } from './vehiclePicker.js';

// Remembers the player's name/color/vehicle pick across reloads so they
// don't have to re-enter it every time. Cleared via the "Reset saved info"
// help-menu button (resetSavedChoices below).
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
    // Storage unavailable (private browsing, quota, etc.) - not persisting
    // is a harmless degradation, so silently ignore.
  }
}

// Lobby UI: name/color/vehicle picker form, join flow (connects to the
// shared room if enabled, then spawns the local car), and the small
// network-status indicator. Isolated from the main loop - once `onJoined`
// fires, the rest of the app takes over per-frame updates.

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../lib/net.js').createNet>} deps.net
 * @param {import('../app/carManager.js').ReturnType} deps.carManager
 * @param {(color: number, vehicleId: string) => void} deps.onJoined - called
 *   once the player has joined (room connected, if applicable) and the
 *   local car should be spawned with the chosen color/vehicle.
 */
export function createLobby({ net, carManager, onJoined, originChain }) {
  const lobbyEl = document.getElementById('lobby');
  // Dev mode skips the name/color prompt entirely (see joinRoom() below)
  // and drives as "dev_mode" in the default blue - hide the prompt so it
  // never flashes on screen.
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

  // ---- Vehicle picker (tabs by category + list of vehicles in that
  // category) - see ui/vehiclePicker.js/lib/vehicles/index.js. Built
  // dynamically rather than hardcoded in index.html so adding a new
  // vehicle/category later needs no HTML changes.
  const vehiclePicker = createVehiclePicker({ tabsEl: vehicleTabsEl, listEl: vehicleListEl });

  // Prefill the form with a previously saved name/color/vehicle, if any,
  // and hide the prompt immediately so it never flashes on screen -
  // tryAutoJoin() (called once terrain is ready) will join with these
  // straight away.
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

  lobbyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = lobbyName.value.trim();
    if (!name || joined || lobbyJoin.disabled) return;
    joinRoom(name, selectedColor(), vehiclePicker.getSelectedId());
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

  // Help-menu button: clears the remembered name/color so the lobby form
  // starts blank again next time (only meaningful before joining, since the
  // form is hidden once in-game - which is also why the click needs its
  // own feedback below, rather than relying on the now-hidden form
  // visibly clearing).
  const resetChoicesBtn = document.getElementById('hud-reset-choices');
  resetChoicesBtn?.addEventListener('click', () => {
    resetSavedChoices();
    const original = resetChoicesBtn.textContent;
    resetChoicesBtn.textContent = 'Cleared ✓';
    resetChoicesBtn.disabled = true;
    setTimeout(() => {
      resetChoicesBtn.textContent = original;
      resetChoicesBtn.disabled = false;
    }, 1500);
  });

  return {
    isJoined: () => joined,
    joinRoom,
    setStatus: setLobbyStatus,
    enableJoinButton: () => {
      lobbyJoin.disabled = false;
    },
    resetSavedChoices,
    // Skips the name/color prompt entirely when a previous choice was
    // saved - called from main.js once terrain is ready, mirroring the
    // dev-mode auto-join below. Returns whether it auto-joined so the
    // caller can fall back to showing the prompt otherwise.
    tryAutoJoin: () => {
      if (!saved) return false;
      joinRoom(saved.name, selectedColor(), vehiclePicker.getSelectedId());
      return true;
    },
  };
}
