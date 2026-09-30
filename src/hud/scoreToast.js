// Short "+N" notice for a score that just landed (a pedestrian or a jump).
// Kilometres stay on the nameplate only; they tick up too quietly for a popup.

const TOAST_MS = 1600;

export function createScoreToast() {
  const root = document.getElementById('score-toasts');

  function push(points, label) {
    if (!root || !points) return;
    const toast = document.createElement('div');
    toast.className = 'score-toast';
    toast.textContent = `+${points} ${label}`;
    root.appendChild(toast);
    setTimeout(() => toast.remove(), TOAST_MS);
  }

  return { push };
}
