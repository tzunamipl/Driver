// "Airtime <points>" banner shown live while the car is flying, so the
// score toast at landing isn't the only feedback for a jump in progress.

export function createAirtimeHud() {
  const root = document.getElementById('airtime-hud');

  function update(points) {
    if (!root) return;
    root.textContent = `Airtime ${points}`;
    root.classList.add('visible');
  }

  function hide() {
    if (!root) return;
    root.classList.remove('visible');
  }

  return { update, hide };
}
