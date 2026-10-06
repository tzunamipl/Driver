import { MAX_GAUGE_SPEED } from '../config.js';

// Speedometer HUD, driven straight off the vehicle's physics state each
// frame. Self-contained (owns its own DOM refs + smoothing state) so it can
// be wired in/out of the main loop independently of the other HUD widgets.

// Six whole kilometres plus a tenths drum. Index 0 is the tenths place.
const ODO_PLACES = 7;
const ODO_DIGIT_H = 24;
// A single frame of real driving stays well under this. Resets and map
// recenters jump farther and must not wind the odometer.
const ODO_TELEPORT_M = 20;

/**
 * @param {object} [options]
 * @param {number} [options.initialKm] - odometer reading to resume from
 *   (e.g. restored from a previous session - see src/lib/carState.js),
 *   instead of always starting back at zero.
 */
export function createGaugesHud({ initialKm = 0 } = {}) {
  const speedoNeedle = document.getElementById('speedo-needle');
  const speedoValue = document.getElementById('speedo-value');
  const odometer = createOdometer(document.getElementById('odometer'), document.getElementById('odo-wheels'), initialKm);
  const tachEl = document.getElementById('tach');
  const tachNeedle = document.getElementById('tach-needle');
  const tachGear = document.getElementById('tach-gear');
  const tachRpm = document.getElementById('tach-rpm');
  const tachTicks = document.getElementById('tach-ticks');
  let tachTicksRedline = -1; // redlineRpm the ticks were last built for

  function updateGauges(chassisMesh, vehicle) {
    if (!chassisMesh || !vehicle) {
      odometer.disarm();
      tachEl?.classList.remove('visible');
      return;
    }
    odometer.addTravel(chassisMesh);

    // Speed: physics velocity magnitude (m/s) -> km/h.
    const v = vehicle.chassisBody.velocity;
    const speedKmh = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * 3.6;
    const clamped = Math.min(speedKmh, MAX_GAUGE_SPEED);
    // Needle sweeps -90deg (0 km/h) to +90deg (MAX_GAUGE_SPEED).
    const needleDeg = -90 + (clamped / MAX_GAUGE_SPEED) * 180;
    speedoNeedle.style.transform = `translate(-50%, -100%) rotate(${needleDeg}deg)`;
    speedoValue.textContent = Math.round(speedKmh);

    // Tachometer + gear indicator (lib/engine.js's rpm/gearbox simulation)
    // - only present on wheeled combustion cars, so this whole gauge is
    // hidden for rigs without one (e.g. the hover chariot).
    const engine = vehicle.engine;
    if (!engine) {
      tachEl?.classList.remove('visible');
      return;
    }
    tachEl?.classList.add('visible');
    if (engine.redlineRpm !== tachTicksRedline) {
      buildTachTicks(tachTicks, engine.redlineRpm);
      tachTicksRedline = engine.redlineRpm;
    }
    const rpmClamped = Math.min(engine.rpm, engine.redlineRpm);
    const tachDeg = rpmToDeg(rpmClamped, engine.redlineRpm);
    tachNeedle.style.transform = `translate(-50%, -100%) rotate(${tachDeg}deg)`;
    tachGear.textContent = engine.gearLabel;
    tachRpm.textContent = `${Math.round(engine.rpm)} RPM`;
  }

  return { updateGauges, getOdometerKm: () => odometer.getKm() };
}

// Needle/tick angle for a given rpm: sweeps -90deg (0 rpm) to +90deg
// (redlineRpm), matching the tach's visual red zone (see index.html's
// conic-gradient, which starts its red wedge at the same 0.8444 fraction).
function rpmToDeg(rpm, redlineRpm) {
  return -90 + (rpm / redlineRpm) * 180;
}

// Builds one tick + krpm label per 1000rpm, from 1000 up to the vehicle's
// own redlineRpm. Rebuilt only when switching to a vehicle with a different
// redlineRpm (see updateGauges), not every frame.
const RED_ZONE_FRACTION = 152 / 180;
function buildTachTicks(container, redlineRpm) {
  if (!container) return;
  container.innerHTML = '';
  for (let rpm = 1000; rpm <= redlineRpm; rpm += 1000) {
    const deg = rpmToDeg(rpm, redlineRpm);
    const isRedline = rpm / redlineRpm >= RED_ZONE_FRACTION;

    const wrap = document.createElement('div');
    wrap.className = 'tach-tick-wrap';
    wrap.style.transform = `rotate(${deg}deg)`;

    const tick = document.createElement('div');
    tick.className = isRedline ? 'tach-tick redline' : 'tach-tick';
    wrap.appendChild(tick);
    container.appendChild(wrap);

    // Label: placed by direct left/top percentages from sin/cos (not
    // nested in a rotated wrapper - see the CSS comment above `.tach-tick`
    // for why that doesn't work) so the number stays upright.
    const rad = (deg * Math.PI) / 180;
    const labelRadiusPct = 33; // distance from dial center, in % of #tach's size
    const label = document.createElement('div');
    label.className = isRedline ? 'tach-tick-label redline' : 'tach-tick-label';
    label.textContent = String(rpm / 1000);
    label.style.left = `${50 + labelRadiusPct * Math.sin(rad)}%`;
    label.style.top = `${50 - labelRadiusPct * Math.cos(rad)}%`;
    container.appendChild(label);
  }
}

function createOdometer(root, wheelsEl, initialKm = 0) {
  const strips = [];
  if (root && wheelsEl) {
    for (let place = ODO_PLACES - 1; place >= 0; place--) {
      if (place === 0) {
        const dot = document.createElement('div');
        dot.className = 'odo-dot';
        wheelsEl.appendChild(dot);
      }
      const digit = document.createElement('div');
      digit.className = place === 0 ? 'odo-digit odo-tenth' : 'odo-digit';
      const strip = document.createElement('div');
      strip.className = 'odo-strip';
      for (let n = 0; n <= 10; n++) {
        const cell = document.createElement('div');
        cell.textContent = String(n % 10);
        strip.appendChild(cell);
      }
      digit.appendChild(strip);
      wheelsEl.appendChild(digit);
      strips[place] = strip;
    }
  }

  let km = initialKm;
  let shownTenths = -1;
  let prevMesh = null;
  let prevX = 0;
  let prevZ = 0;

  function disarm() {
    prevMesh = null;
  }

  function addTravel(chassisMesh) {
    const x = chassisMesh.position.x;
    const z = chassisMesh.position.z;
    if (chassisMesh !== prevMesh) {
      prevMesh = chassisMesh;
      prevX = x;
      prevZ = z;
      return;
    }
    const dist = Math.hypot(x - prevX, z - prevZ);
    prevX = x;
    prevZ = z;
    if (dist === 0 || dist >= ODO_TELEPORT_M) return;
    km += dist / 1000;
    paint();
  }

  function paint() {
    for (let place = 0; place < strips.length; place++) {
      const strip = strips[place];
      if (!strip) continue;
      strip.style.transform = `translateY(${-wheelPosition(km, place) * ODO_DIGIT_H}px)`;
    }
    const tenths = Math.floor(km * 10);
    if (root && tenths !== shownTenths) {
      shownTenths = tenths;
      root.setAttribute('aria-label', `Licznik ${km.toFixed(1)} kilometrów`);
    }
  }

  paint();
  return { addTravel, disarm, getKm: () => km };
}

// Position of one drum in digit-heights, 0..10. The tenths drum rolls
// continuously. Each drum to its left only turns while the one on its
// right is passing from 9 to 0, the way a mechanical odometer does.
function wheelPosition(km, place) {
  const tenths = Math.max(0, km) * 10;
  if (place === 0) return mod10(tenths);
  const lower = mod10(tenths / 10 ** (place - 1));
  const base = Math.floor(mod10(tenths / 10 ** place));
  if (lower >= 9) return base + (lower - 9);
  return base;
}

function mod10(n) {
  const m = n % 10;
  return m < 0 ? m + 10 : m;
}
