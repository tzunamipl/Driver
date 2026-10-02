// General-purpose "something happened" system notice - longer-lived and
// more explanatory than scoreToast.js's quick "+N" popups (e.g. "car was
// stuck with no ground and got teleported back to start"), so the player
// isn't left wondering why their position suddenly changed.

const NOTICE_MS = 5000;

export function createNoticeHud() {
  const root = document.getElementById('system-notices');

  function show(message, ms = NOTICE_MS) {
    if (!root || !message) return;
    const notice = document.createElement('div');
    notice.className = 'system-notice';
    notice.textContent = message;
    root.appendChild(notice);
    setTimeout(() => notice.remove(), ms);
  }

  return { show };
}
