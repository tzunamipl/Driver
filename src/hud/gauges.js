import * as THREE from 'three';
import { MAX_GAUGE_SPEED } from '../config.js';
import { createWarningLamps } from './warningLamps.js';
import { createAuxGauge } from './auxGauge.js';
import { createBoostGauge } from './boostGauge.js';
import { createOutsideTempLcd } from './outsideTempLcd.js';
import { createFuelAverageLcd } from './fuelAverageLcd.js';
import { buildDialScale, valueToDeg } from './dialScale.js';
import { speedValue, speedUnit, longDistanceValue, longDistanceUnit, onUnitsChange, isImperial } from '../lib/units.js';

// Speedometer HUD, driven straight off the vehicle's physics state each
// frame. The speedo reads driven-wheel speed like a real one (wheelspin shows);
// true speed over ground goes to the readout beside the minimap. Self-contained (owns its own DOM refs + smoothing state) so it can
// be wired in/out of the main loop independently of the other HUD widgets.

// Whole kilometres (miles in imperial units) plus a tenths drum (index 0 is the tenths place).
const ODO_PLACES = 7;
const TRIP_PLACES = 5;
// Speedo label steps (km/h or mph), smallest that keeps the dial under SPEEDO_MAX_LABELS intervals.
const SPEEDO_STEPS = [20, 40, 50, 100];
const SPEEDO_MAX_LABELS = 8;
// Sun intensity giving the needle hubs their full highlight (noon in app/daylight.js).
const HUB_FULL_LIGHT = 3.2;
const toLight = new THREE.Vector3();
const camAxis = new THREE.Vector3();
// A single frame of real driving stays well under this. Resets and map
// recenters jump farther and must not wind the odometer.
const ODO_TELEPORT_M = 20;

/**
 * @param {object} [options]
 * @param {number} [options.initialTripKm] - km driven in this save so far
 *   (see src/lib/carState.js); the odometer itself is set per car via setOdometerKm.
 * @param {() => void} [options.onLightsClick] - dash headlight lamp clicked
 * @param {() => void} [options.onHandbrakeClick] - dash handbrake lamp clicked
 * @param {() => void} [options.onGearModeClick] - tach gearbox-mode badge clicked
 * @param {() => void} [options.onTransmissionClick] - tach AUTO/MAN badge clicked
 */
export function createGaugesHud({ initialTripKm = 0, onLightsClick, onHandbrakeClick, onGearModeClick, onTransmissionClick } = {}) {
  const speedoNeedle = document.getElementById('speedo-needle');
  const groundSpeedEl = document.getElementById('ground-speed');
  const groundSpeedValue = document.getElementById('ground-speed-value');
  let groundSpeedShown = null;
  const speedoTicks = document.getElementById('speedo-ticks');
  let speedoScale = null;
  let speedoScaleTop = -1; // topSpeedKmh the scale was last built for
  const speedoUnitEl = document.getElementById('speedo-unit');
  const groundSpeedUnit = document.getElementById('ground-speed-unit');
  const odometer = createOdometer(document.getElementById('odometer'), document.getElementById('odo-wheels'), document.getElementById('odo-trip-wheels'), initialTripKm);
  function showUnits() {
    speedoScaleTop = -1; // rebuilt on the next frame
    groundSpeedShown = null;
    if (speedoUnitEl) speedoUnitEl.textContent = speedUnit();
    if (groundSpeedUnit) groundSpeedUnit.textContent = speedUnit();
    odometer.repaint();
  }
  showUnits();
  onUnitsChange(showUnits);
  const tachEl = document.getElementById('tach');
  const tachNeedle = document.getElementById('tach-needle');
  const tachTicks = document.getElementById('tach-ticks');
  let tachTicksRedline = -1; // redlineRpm the ticks were last built for
  const auxGauge = createAuxGauge(document.getElementById('aux-gauge'));
  const boostGauge = createBoostGauge(document.getElementById('boost-gauge'));
  const outsideTemp = createOutsideTempLcd(document.getElementById('outside-temp'));
  const fuelAverage = createFuelAverageLcd(document.getElementById('fuel-average'));
  const lamps = createWarningLamps(document.getElementById('warning-lamps'), { onLightsClick, onHandbrakeClick });
  let lightsShown = null;
  const gaugesEl = document.getElementById('gauges');
  let hubShown = '';
  const gearModeEl = document.getElementById('gear-mode');
  // Blur so Space (handbrake) doesn't re-click the focused button.
  gearModeEl?.addEventListener('click', () => {
    onGearModeClick?.();
    gearModeEl.blur();
  });
  let gearModeShown = null;
  const transmissionEl = document.getElementById('transmission-mode');
  transmissionEl?.addEventListener('click', () => {
    onTransmissionClick?.();
    transmissionEl.blur();
  });
  let transmissionShown = null;
  const cruiseLimitEl = document.getElementById('cruise-limit');
  let cruiseLimitShown = null;

  function updateGauges(chassisMesh, vehicle, handbrake, lightsOn = false, gearMode = 'sport', transmission = 'auto', cruiseLimitKmh = 0) {
    const lights = !!vehicle && lightsOn;
    if (lights !== lightsShown) {
      lightsShown = lights;
      gaugesEl?.classList.toggle('dash-lit', lights);
    }
    lamps.update(vehicle ?? null, { handbrake, lightsOn: lights });
    if (!chassisMesh || !vehicle) {
      odometer.disarm();
      if (groundSpeedEl) groundSpeedEl.hidden = true;
      groundSpeedShown = null;
      tachEl?.classList.remove('visible');
      auxGauge.update(null);
      outsideTemp.update(false);
      fuelAverage.update(null);
      return;
    }
    odometer.addTravel(chassisMesh);

    // Ground speed: physics velocity magnitude (m/s) -> km/h.
    const v = vehicle.chassisBody.velocity;
    const groundKmh = Math.round(speedValue(Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * 3.6));
    if (groundSpeedEl && groundKmh !== groundSpeedShown) {
      groundSpeedShown = groundKmh;
      groundSpeedEl.hidden = false;
      groundSpeedValue.textContent = groundKmh;
    }
    // Hover rigs have no wheels: their speedo reads ground speed.
    const wheelSpeed = vehicle.getDriveWheelSpeed?.();
    const speedKmh = wheelSpeed === undefined ? groundKmh : Math.abs(wheelSpeed) * 3.6;
    const topSpeedKmh = vehicle.engine?.topSpeedKmh ?? MAX_GAUGE_SPEED;
    if (topSpeedKmh !== speedoScaleTop) {
      speedoScaleTop = topSpeedKmh;
      speedoScale = speedoScaleFor(speedValue(topSpeedKmh));
      buildDialScale(speedoTicks, { ...speedoScale, labelRadiusPct: 35 });
    }
    const needleDeg = valueToDeg(Math.min(speedValue(speedKmh), speedoScale.max), speedoScale.max);
    speedoNeedle.style.transform = `translate(-50%, -100%) rotate(${needleDeg}deg)`;

    // Tachometer + gear indicator (lib/engine.js's rpm/gearbox simulation)
    // - only present on wheeled combustion cars, so this whole gauge is
    // hidden for rigs without one (e.g. the hover chariot).
    const engine = vehicle.engine;
    auxGauge.update(engine ?? null);
    boostGauge.update(engine ?? null);
    outsideTemp.update(!!vehicle.outsideTempGauge);
    fuelAverage.update(vehicle.outsideTempGauge ? vehicle.fuel : null);
    if (!engine) {
      tachEl?.classList.remove('visible');
      return;
    }
    tachEl?.classList.add('visible');
    if (engine.redlineRpm !== tachTicksRedline) {
      buildDialScale(tachTicks, {
        max: engine.redlineRpm,
        step: 1000,
        redFrom: engine.redlineRpm * RED_ZONE_FRACTION,
        label: (rpm) => String(rpm / 1000),
        labelRadiusPct: 33,
      });
      tachTicksRedline = engine.redlineRpm;
    }
    const tachDeg = valueToDeg(Math.min(engine.rpm, engine.redlineRpm), engine.redlineRpm);
    tachNeedle.style.transform = `translate(-50%, -100%) rotate(${tachDeg}deg)`;
    if (gearMode !== gearModeShown && gearModeEl) {
      gearModeShown = gearMode;
      gearModeEl.textContent = gearMode.toUpperCase();
      gearModeEl.dataset.mode = gearMode;
    }
    const shownTransmission = `${transmission}|${engine.automatic}|${engine.manual}`;
    if (shownTransmission !== transmissionShown && transmissionEl) {
      transmissionShown = shownTransmission;
      transmissionEl.textContent = engine.manual ? 'MAN' : 'AUTO';
      transmissionEl.dataset.mode = engine.manual ? 'manual' : 'auto';
      transmissionEl.disabled = engine.automatic;
      transmissionEl.title = engine.automatic
        ? 'Automatic gearbox - no manual mode for this vehicle'
        : 'Gearbox: automatic / manual (click to switch)';
      gearModeEl?.classList.toggle('inactive', engine.manual);
    }
    // Imperial: the nearest 5 mph, as on a real sign.
    const limit = gearMode === 'cruise' && !engine.manual && cruiseLimitKmh > 0 ? (isImperial() ? Math.round(speedValue(cruiseLimitKmh) / 5) * 5 : cruiseLimitKmh) : 0;
    if (limit !== cruiseLimitShown && cruiseLimitEl) {
      cruiseLimitShown = limit;
      cruiseLimitEl.hidden = !limit;
      cruiseLimitEl.textContent = limit ? String(limit) : '';
    }
  }

  /** Moves the needle hubs' specular highlight to where `light` (the sun/moon) would put it from this camera. */
  function updateHubLight(camera, light) {
    if (!gaugesEl) return;
    toLight.subVectors(light.position, light.target.position).normalize();
    // Blinn half vector in camera space, viewer along +z.
    const x = toLight.dot(camAxis.set(1, 0, 0).applyQuaternion(camera.quaternion));
    const y = toLight.dot(camAxis.set(0, 1, 0).applyQuaternion(camera.quaternion));
    const z = toLight.dot(camAxis.set(0, 0, 1).applyQuaternion(camera.quaternion)) + 1;
    const len = Math.hypot(x, y, z) || 1;
    const strength = Math.min(1, light.intensity / HUB_FULL_LIGHT) * (0.4 + 0.6 * (z / len));
    const c = light.color;
    const rgb = [c.r, c.g, c.b].map((v) => Math.round(255 * (0.4 + 0.6 * Math.min(1, v)))).join(', ');
    const hx = Math.round(50 + 38 * (x / len));
    const hy = Math.round(50 - 38 * (y / len));
    const spec = strength.toFixed(2);
    const hub = `${hx}|${hy}|${spec}|${rgb}`;
    if (hub === hubShown) return;
    hubShown = hub;
    gaugesEl.style.setProperty('--hub-x', `${hx}%`);
    gaugesEl.style.setProperty('--hub-y', `${hy}%`);
    gaugesEl.style.setProperty('--hub-spec', spec);
    gaugesEl.style.setProperty('--hub-rgb', rgb);
  }

  return {
    updateGauges,
    updateHubLight,
    shiftOrigin: odometer.shiftOrigin,
    getOdometerKm: odometer.getKm,
    setOdometerKm: odometer.setKm,
    getTripKm: odometer.getTripKm,
  };
}

// The tach's red wedge (conic-gradient in gauges.css) starts at the same fraction.
const RED_ZONE_FRACTION = 152 / 180;

/** Speedo scale reaching the car's gearing top speed, rounded up to a whole label step. */
function speedoScaleFor(topSpeed) {
  const step = SPEEDO_STEPS.find((s) => Math.ceil(topSpeed / s) <= SPEEDO_MAX_LABELS) ?? SPEEDO_STEPS.at(-1);
  return { max: Math.max(step, Math.ceil(topSpeed / step) * step), step, minorStep: step / 2 };
}

// Car odometer (km, set per car) over the save's trip meter (tripKm); both wind with the same travel, shown in km or miles.
function createOdometer(root, wheelsEl, tripWheelsEl, initialTripKm = 0) {
  const unitEl = document.getElementById('odo-unit');
  const paintOdo = createDrums(wheelsEl, ODO_PLACES);
  const paintTrip = createDrums(tripWheelsEl, TRIP_PLACES);

  let km = 0;
  let tripKm = initialTripKm;
  let shownLabel = '';
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
    tripKm += dist / 1000;
    paint();
  }

  function paint() {
    paintOdo(longDistanceValue(km));
    paintTrip(longDistanceValue(tripKm));
    const unit = isImperial() ? 'miles' : 'kilometres';
    const label = `Odometer ${longDistanceValue(km).toFixed(1)} ${unit}, trip ${longDistanceValue(tripKm).toFixed(1)} ${unit}`;
    if (root && label !== shownLabel) {
      shownLabel = label;
      root.setAttribute('aria-label', label);
    }
  }

  paint();
  /** Floating-origin shift: not travel. */
  function shiftOrigin(dx, dz) {
    prevX -= dx;
    prevZ -= dz;
  }

  function setKm(value) {
    km = value;
    paint();
  }

  function repaint() {
    if (unitEl) unitEl.textContent = longDistanceUnit();
    paint();
  }

  return { addTravel, disarm, shiftOrigin, setKm, repaint, getKm: () => km, getTripKm: () => tripKm };
}

/** Builds a row of number drums in `wheelsEl`; returns paint(km). */
function createDrums(wheelsEl, places) {
  const strips = [];
  if (!wheelsEl) return () => {};
  for (let place = places - 1; place >= 0; place--) {
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
  return (km) => {
    // Percent of the strip's own height (11 cells), so each row sizes its drums in CSS.
    for (let place = 0; place < places; place++) {
      strips[place].style.transform = `translateY(${(-wheelPosition(km, place) * 100) / 11}%)`;
    }
  };
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
