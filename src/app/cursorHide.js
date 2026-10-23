// Hides the mouse cursor while the car is driving; any mouse move or stopping brings it back.

// Hysteresis so the cursor doesn't flicker around walking pace.
const HIDE_ABOVE_MPS = 2;
const SHOW_BELOW_MPS = 0.5;
// After a mouse move, driving on hides the cursor again once the mouse rests this long.
const MOUSE_IDLE_MS = 1500;

export function createCursorHide(root = document.documentElement) {
  let hidden = false;
  let moving = false;
  let lastMouseMove = -Infinity;

  function setHidden(value) {
    if (hidden === value) return;
    hidden = value;
    root.classList.toggle('cursor-hidden', value);
  }

  window.addEventListener('mousemove', (event) => {
    // Some browsers fire a zero-delta mousemove when the cursor style changes.
    if (event.movementX === 0 && event.movementY === 0) return;
    lastMouseMove = performance.now();
    setHidden(false);
  });

  /** `speed` = car speed in m/s, or null when there is no car. */
  function update(speed) {
    if (speed == null) moving = false;
    else if (speed > HIDE_ABOVE_MPS) moving = true;
    else if (speed < SHOW_BELOW_MPS) moving = false;
    setHidden(moving && performance.now() - lastMouseMove >= MOUSE_IDLE_MS);
  }

  return { update };
}
