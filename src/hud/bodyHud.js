// Body debug panel: broken lamps (lampDamage.js) and exhaust health (exhaustDamage.js), with Break / Wear / Fix buttons.

export function createBodyHud() {
  const panel = document.getElementById('body-hud');
  const headVal = document.getElementById('body-lamps-head');
  const tailVal = document.getElementById('body-lamps-tail');
  const exhaustVal = document.getElementById('body-exhaust');
  let vehicle = null;
  // Blur so Space (handbrake) doesn't re-click the focused button.
  function onClick(id, part, action) {
    const button = document.getElementById(id);
    button?.addEventListener('click', () => {
      if (vehicle?.[part]) action(vehicle[part]);
      button.blur();
    });
  }
  onClick('body-lamps-break', 'lamps', (lamps) => lamps.setState({ head: [true, true], tail: [true, true] }));
  onClick('body-lamps-fix', 'lamps', (lamps) => lamps.repair());
  onClick('body-exhaust-wear', 'exhaust', (exhaust) => exhaust.wear());
  onClick('body-exhaust-fix', 'exhaust', (exhaust) => exhaust.repair());

  const marks = (sides) => sides.map((b) => (b ? '✗' : '✓')).join(' ');

  function updateBodyHud(nextVehicle, debugVisualsEnabled) {
    if (!debugVisualsEnabled || !nextVehicle) return;
    vehicle = nextVehicle;
    if (panel) panel.hidden = !vehicle.lamps;
    const broken = vehicle.lamps?.broken;
    if (!broken) return;
    headVal.textContent = marks(broken.head);
    tailVal.textContent = marks(broken.tail);
    const exhaust = vehicle.exhaust;
    if (exhaustVal && exhaust) exhaustVal.textContent = !exhaust.breakable ? 'none' : exhaust.detached ? 'fell off' : `${Math.round(exhaust.health * 100)}%`;
  }

  return { updateBodyHud };
}
