// Gear strip LCD above the speedo for automatic-only boxes (no gearstick to show): R and every
// forward gear, the engaged one lit. Pops up for a moment on a Q/E shift.

const SHOW_MS = 1500;

/** @param {HTMLElement | null} root - #gear-lcd */
export function createGearLcd(root) {
  if (!root) return { update() {} };
  let engineShown = null;
  let pressesSeen = 0;
  let hideAt = 0;
  let cells = [];
  let litGear = null;

  function build(engine) {
    root.replaceChildren();
    cells = [0, ...Array.from({ length: engine.gearCount }, (_, i) => i + 1)].map((gear) => {
      const cell = document.createElement('span');
      cell.className = 'gear-lcd-cell';
      cell.textContent = engine.labelForGear(gear);
      cell.dataset.gear = String(gear);
      root.appendChild(cell);
      return cell;
    });
    litGear = null;
  }

  /** Per frame with the local car's engine (null for none). */
  function update(engine) {
    const presses = engine?.autoShiftPresses ?? 0;
    if (engine !== engineShown) {
      engineShown = engine;
      pressesSeen = presses;
      hideAt = 0;
      if (engine?.automatic) build(engine);
    }
    const now = performance.now();
    if (presses !== pressesSeen && engine.automatic) hideAt = now + SHOW_MS;
    pressesSeen = presses;
    const show = now < hideAt;
    if (root.hidden === show) root.hidden = !show;
    if (!show || engine.gear === litGear) return;
    litGear = engine.gear;
    for (const cell of cells) cell.classList.toggle('lit', Number(cell.dataset.gear) === litGear);
  }

  return { update };
}
