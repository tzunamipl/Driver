// Headlight on/off: follows the sun (on below LIGHTS_ON_ELEVATION_DEG) until
// the player flips it with L or the dash lamp; that choice holds until the
// next dusk/dawn hands control back to auto.

const LIGHTS_ON_ELEVATION_DEG = 1;

export function createHeadlightSwitch({ onToggle } = {}) {
  let manual = null; // null = auto
  let wasNight = null;
  let on = null; // null until the first update, so startup doesn't click
  let wasPressed = false;
  let clicked = false;

  /** Call once per frame; returns whether the lights are on. */
  function update(keyPressed, sunElevationDeg) {
    const night = sunElevationDeg < LIGHTS_ON_ELEVATION_DEG;
    if (wasNight !== null && night !== wasNight) manual = null;
    wasNight = night;
    if ((keyPressed && !wasPressed) || clicked) manual = !(on ?? night);
    wasPressed = keyPressed;
    clicked = false;
    const next = manual ?? night;
    if (on !== null && next !== on) onToggle?.(next);
    on = next;
    return on;
  }

  return {
    update,
    toggle: () => (clicked = true),
    isNight: () => !!wasNight,
    isOn: () => !!on,
  };
}
