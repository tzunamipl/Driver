// Warning-lamp strip under the round gauges: one row of the lamps the current
// vehicle has. Placeholder lamps (no `on`) stay dark until their feature exists.

// Momentary lamps (ABS, traction control) stay lit this long so they don't flicker.
const HOLD_MS = 300;
// Low-fuel lamp below this tank fraction (the fuel gauge's red band).
const LOW_FUEL_FRACTION = 0.125;

const wheeled = (v) => v.vehicleType !== 'hover';
const hasEngine = (v) => !!v.engine;

// Strip order, left to right.
const LAMPS = [
  {
    // Click only latches; Space releases it.
    id: 'handbrake', title: 'Handbrake (click to apply, Space releases)', color: 'red', has: wheeled,
    click: (v, h) => h.onHandbrakeClick?.(),
    on: (v, s) => !!s.handbrake?.on, glow: (v, s) => !!s.handbrake?.latched,
    svg: '<circle cx="16" cy="12" r="8"/><path d="M6 4.5a11 11 0 0 0 0 15M26 4.5a11 11 0 0 1 0 15"/><text x="16" y="16.2" font-size="11">P</text>',
  },
  {
    id: 'lights', title: 'Headlights (L)', color: 'green', has: () => true, click: (v, h) => h.onLightsClick?.(),
    on: (v, s) => s.lightsOn, glow: (v, s) => s.lightsOn,
    svg: '<path class="lamp" d="M17 5c6 0 9.5 3 9.5 7s-3.5 7-9.5 7z"/><path d="M13.5 6.5L5 8.5M13.5 10.5L5 12.5M13.5 14.5L5 16.5"/>',
  },
  {
    // Amber while ABS works a wheel, steady red while switched off (click toggles).
    id: 'abs', title: 'ABS (click to switch off/on)', color: 'amber', has: (v) => wheeled(v) && !!v.abs, hold: true,
    on: (v) => v.absOff || v.wheelInfos.some((w) => w.absActive),
    colorOf: (v) => (v.absOff ? 'red' : 'amber'),
    click: (v) => { v.absOff = !v.absOff; },
    svg: '<circle cx="16" cy="12" r="8"/><path d="M6 4.5a11 11 0 0 0 0 15M26 4.5a11 11 0 0 1 0 15"/><text x="16" y="14.6" font-size="6.5">ABS</text>',
  },
  {
    id: 'brakes', title: 'Brakes (low fluid or overheating)', color: 'red', has: (v) => !!v.brakes, on: (v) => v.brakes.warning,
    svg: '<circle cx="16" cy="12" r="8"/><path d="M6 4.5a11 11 0 0 0 0 15M26 4.5a11 11 0 0 1 0 15"/><text x="16" y="16.2" font-size="11">!</text>',
  },
  {
    // Amber while TC trims a driven wheel, steady red while switched off (click toggles).
    id: 'wheelspin', title: 'Traction control (click to switch off/on)', color: 'amber', has: (v) => wheeled(v) && hasEngine(v) && !!v.tractionControl, hold: true,
    on: (v) => v.tcOff || v.wheelInfos.some((w) => w.tcActive),
    colorOf: (v) => (v.tcOff ? 'red' : 'amber'),
    click: (v) => { v.tcOff = !v.tcOff; },
    svg: '<path d="M8 13l2.5-5h11l2.5 5v3H8z"/><path d="M7 21q2-2.5 4 0t4 0M17 21q2-2.5 4 0t4 0"/>',
  },
  {
    id: 'check-engine', title: 'Check engine (overheating or worn engine: reduced power)', color: 'amber', has: hasEngine, on: (v) => (v.heat?.powerFactor ?? 1) < 1,
    svg: '<path d="M5 10v6M5 13h3M8 9h4l2-2h5v2h3l2 2h2v-2h2v9h-2v-2h-2l-2 3H11l-3-3z"/><path d="M14 4h7M17.5 4v3"/>',
  },
  {
    id: 'oil', title: 'Oil pressure', color: 'red', has: hasEngine, on: (v) => !!v.heat?.oilWarning,
    svg: '<path d="M4 10l4 1 3-2h7l9-3-7 10H11l-3-3-4-1z"/><path d="M27.5 13v2.5"/>',
  },
  {
    id: 'battery', title: 'Charging', color: 'red', has: hasEngine,
    svg: '<rect x="5" y="8" width="22" height="12" rx="1"/><path d="M9 8V5.5h3V8M20 8V5.5h3V8M9 14h4M19.5 14h4M21.5 12v4"/>',
  },
  {
    id: 'coolant', title: 'Coolant temperature', color: 'red', has: hasEngine, on: (v) => !!v.heat?.coolantWarning,
    svg: '<path d="M16 3v10M16 5h4M16 8h4M16 11h4"/><circle cx="16" cy="15.5" r="2.5"/><path d="M4 21q3-2.5 6 0t6 0t6 0t6 0"/>',
  },
  {
    id: 'fuel', title: 'Low fuel', color: 'amber', has: hasEngine, on: (v) => !!v.fuel && v.fuel.fraction < LOW_FUEL_FRACTION,
    svg: '<rect x="7" y="4" width="11" height="17" rx="1"/><path d="M9.5 8.5h6M18 10h3l2 2v6.5a1.5 1.5 0 0 0 3 0V9l-3-3"/>',
  },
  {
    id: 'trailer', title: 'Trailer coupled', color: 'green', has: (v) => !!v.hasTrailer,
    on: () => true,
    svg: '<rect x="12" y="5" width="16" height="11" rx="1"/><path d="M5 14h7"/><circle cx="5" cy="14" r="1.5"/><circle cx="20" cy="18.5" r="2.5"/>',
  },
];

/** A lamp's SVG body (viewBox 0 0 32 24), for reuse as a gauge icon. */
export function lampIconSvg(id) {
  return LAMPS.find((lamp) => lamp.id === id)?.svg ?? '';
}

/**
 * @param {HTMLElement | null} root - the panel element (#warning-lamps)
 * @param {object} [options]
 * @param {() => void} [options.onLightsClick] - headlight lamp clicked
 * @param {() => void} [options.onHandbrakeClick] - handbrake lamp clicked
 */
export function createWarningLamps(root, { onLightsClick, onHandbrakeClick } = {}) {
  let builtFor = null; // vehicle the panel was last built for
  let shown = []; // { lamp, el, on, glow, color, litUntil }

  function build(vehicle) {
    builtFor = vehicle;
    root.innerHTML = '';
    shown = [];
    if (!vehicle) return;
    for (const lamp of LAMPS) {
      if (!lamp.has(vehicle)) continue;
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      el.setAttribute('viewBox', '0 0 32 24');
      el.setAttribute('class', `warning-lamp ${lamp.color}${lamp.on ? '' : ' placeholder'}`);
      el.innerHTML = `<title>${lamp.title}</title>${lamp.svg}`;
      if (lamp.click) {
        el.setAttribute('role', 'button');
        el.setAttribute('aria-pressed', 'false');
        el.classList.add('clickable');
        el.addEventListener('click', () => lamp.click(vehicle, { onLightsClick, onHandbrakeClick }));
      }
      root.appendChild(el);
      shown.push({ lamp, el, on: false, glow: false, color: lamp.color, litUntil: 0 });
    }
  }

  /** state: { handbrake, lightsOn } */
  function update(vehicle, state) {
    if (!root) return;
    if (vehicle !== builtFor) build(vehicle);
    root.hidden = !vehicle;
    if (!vehicle) return;
    const now = performance.now();
    for (const item of shown) {
      let on = !!item.lamp.on?.(vehicle, state);
      if (item.lamp.hold) {
        if (on) item.litUntil = now + HOLD_MS;
        on = now < item.litUntil;
      }
      const glow = on && !!item.lamp.glow?.(vehicle, state);
      if (on !== item.on) {
        item.on = on;
        item.el.classList.toggle('on', on);
        if (item.lamp.click) item.el.setAttribute('aria-pressed', String(on));
      }
      const color = item.lamp.colorOf?.(vehicle) ?? item.lamp.color;
      if (color !== item.color) {
        item.el.classList.replace(item.color, color);
        item.color = color;
      }
      if (glow !== item.glow) {
        item.glow = glow;
        item.el.classList.toggle('glow', glow);
      }
    }
  }

  return { update };
}
