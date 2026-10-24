// Body debug panel: broken lamps (lampDamage.js), with Break / Fix buttons.

export function createBodyHud() {
  const panel = document.getElementById('body-hud');
  const headVal = document.getElementById('body-lamps-head');
  const tailVal = document.getElementById('body-lamps-tail');
  let vehicle = null;
  // Blur so Space (handbrake) doesn't re-click the focused button.
  function onClick(id, action) {
    const button = document.getElementById(id);
    button?.addEventListener('click', () => {
      if (vehicle?.lamps) action(vehicle.lamps);
      button.blur();
    });
  }
  onClick('body-lamps-break', (lamps) => lamps.setState({ head: [true, true], tail: [true, true] }));
  onClick('body-lamps-fix', (lamps) => lamps.repair());

  const marks = (sides) => sides.map((b) => (b ? '✗' : '✓')).join(' ');

  function updateBodyHud(nextVehicle, debugVisualsEnabled) {
    if (!debugVisualsEnabled || !nextVehicle) return;
    vehicle = nextVehicle;
    if (panel) panel.hidden = !vehicle.lamps;
    const broken = vehicle.lamps?.broken;
    if (!broken) return;
    headVal.textContent = marks(broken.head);
    tailVal.textContent = marks(broken.tail);
  }

  return { updateBodyHud };
}
