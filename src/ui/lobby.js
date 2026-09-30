import { BODY_COLORS, NET_STATUS_TEXT, IS_DEV_MODE, CAN_USE_NETWORK } from '../config.js';

// Lobby UI: name/color picker form, join flow (connects to the shared room
// if enabled, then spawns the local car), and the small network-status
// indicator. Isolated from the main loop - once `onJoined` fires, the rest
// of the app takes over per-frame updates.

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../lib/net.js').createNet>} deps.net
 * @param {import('../app/carManager.js').ReturnType} deps.carManager
 * @param {(color: number) => void} deps.onJoined - called once the player
 *   has joined (room connected, if applicable) and the local car should be
 *   spawned with the chosen color.
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
  const lobbyColors = document.getElementById('lobby-colors');
  const netStatusEl = document.getElementById('net-status');

  let selectedColor = BODY_COLORS[0];
  let joined = false;

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

  for (const color of BODY_COLORS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.dataset.color = String(color);
    swatch.style.background = `#${color.toString(16).padStart(6, '0')}`;
    swatch.setAttribute('aria-label', swatch.style.background);
    if (color === selectedColor) swatch.classList.add('selected');
    swatch.addEventListener('click', () => {
      selectedColor = color;
      for (const button of lobbyColors.children) button.classList.toggle('selected', button === swatch);
    });
    lobbyColors.appendChild(swatch);
  }

  async function joinRoom(name, color) {
    if (joined) return;
    lobbyJoin.disabled = true;
    if (CAN_USE_NETWORK) {
      setLobbyStatus('Connecting…');
      try {
        await net.connect({ name, color });
        await originChain();
      } catch (err) {
        console.warn('Room connect failed', err);
      }
    }

    carManager.setLocalName(name.slice(0, 16));
    joined = true;
    lobbyEl.style.display = 'none';
    netStatusEl.hidden = false;
    setNetStatus(CAN_USE_NETWORK && net.isOnline() ? 'online' : 'offline');
    onJoined(color);
  }

  lobbyForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = lobbyName.value.trim();
    if (!name || joined || lobbyJoin.disabled) return;
    joinRoom(name, selectedColor);
  });

  window.addEventListener('pagehide', () => {
    if (joined) net.publishLeave();
  });

  return {
    isJoined: () => joined,
    joinRoom,
    setStatus: setLobbyStatus,
    enableJoinButton: () => {
      lobbyJoin.disabled = false;
    },
  };
}
