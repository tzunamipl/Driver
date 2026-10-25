// Free roam: with the car nearly stopped, a floating button points at each damaged part
// (flat or worn tyre, worn shock, leaking radiator / low coolant, broken lamp, worn gearbox,
// low fuel) and fixes that part on a click (hud/repairCallouts.js). Resets and teleports don't fix the car.

import * as THREE from 'three';
import { createRepairCallouts } from '../hud/repairCallouts.js';

// m/s: shown once this slow, kept until faster than the second (no flicker at walking pace).
const SHOW_SPEED = 0.8;
const HIDE_SPEED = 1.5;
// Tread below this offers a fresh tyre (the tyre service dialog's "Worn").
const WORN_TREAD = 0.35;
// Shock / gearbox health and coolant level below these offer a fix.
const WORN_SHOCK = 0.95;
const WORN_GEARBOX = 0.95;
const LOW_COOLANT = 0.95;
const LOW_FUEL = 0.125; // the low-fuel warning lamp's
const LAMP_SIDE_SHARE = 0.7; // lamp anchors this far out of the body's half width
const SIDE_NAMES = ['left', 'right']; // lampDamage.js sides: 0 = +x (left)
const CENTRE_PX = 30; // parts this close to the car's middle on screen put their card right (no flip-flop)

const pct = (v) => `${Math.round(v * 100)}%`;

/** Chassis-local box of the body's shapes (offsets only: shapes are axis-aligned). */
function localBounds(body) {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  body.shapes.forEach((shape, i) => {
    const o = body.shapeOffsets[i];
    const h = shape.halfExtents ?? { x: shape.boundingSphereRadius, y: shape.boundingSphereRadius, z: shape.boundingSphereRadius };
    min.min(new THREE.Vector3(o.x - h.x, o.y - h.y, o.z - h.z));
    max.max(new THREE.Vector3(o.x + h.x, o.y + h.y, o.z + h.z));
  });
  return { min, max };
}

/**
 * @param {object} deps
 * @param {HTMLCanvasElement} deps.canvas
 * @param {THREE.Camera} deps.camera
 * @param {() => object | null} deps.getVehicle
 * @param {() => void} [deps.onRepair] - sound when a part is fixed.
 */
export function createRoadsideRepair({ canvas, camera, getVehicle, onRepair }) {
  const hud = createRepairCallouts();
  const point = new THREE.Vector3();
  const chassisQuat = new THREE.Quaternion();
  let bounds = null;
  let boundsFor = null;
  let shown = false;

  /** Every damaged part: { label, note, local (chassis-local anchor) | world, fix }. */
  function damagedParts(vehicle) {
    const parts = [];
    const labels = vehicle.wheelLabels ?? [];
    vehicle.wheelInfos.forEach((w, i) => {
      const at = labels[i] ? ` · ${labels[i]}` : '';
      if (w.punctured || w.tread < WORN_TREAD) {
        parts.push({ label: `Replace tyre${at}`, note: w.punctured ? 'Flat' : `Worn · tread ${pct(w.tread)}`, world: w.worldTransform.position, fix: () => vehicle.repairTyres(i) });
      }
      if (w.shockHealth < WORN_SHOCK) {
        parts.push({ label: `Replace shock${at}`, note: `Health ${pct(w.shockHealth)}`, world: w.connectionPointWorld, fix: () => vehicle.repairShocks(i) });
      }
    });
    const { min, max } = bounds;
    const midY = (min.y + max.y) / 2;
    const heat = vehicle.heat;
    if (heat && (heat.leakLps > 0 || heat.level < LOW_COOLANT)) {
      const leaking = heat.leakLps > 0;
      parts.push({ label: leaking ? 'Fix radiator' : 'Top up coolant', note: `${leaking ? 'Leaking · ' : ''}coolant ${pct(heat.level)}`, local: new THREE.Vector3(0, midY, max.z), fix: () => heat.repair() });
    }
    const fuel = vehicle.fuel;
    if (fuel && fuel.fraction < LOW_FUEL) {
      // Filler on the left rear quarter.
      parts.push({ label: 'Refuel', note: fuel.litres > 0 ? `Low · ${fuel.litres.toFixed(1)} L` : 'Empty', local: new THREE.Vector3(max.x, midY, min.z * 0.6), fix: () => fuel.setLitres(fuel.capacityL) });
    }
    const lamps = vehicle.lamps;
    for (const kind of ['head', 'tail']) {
      lamps?.broken[kind].forEach((broken, side) => {
        if (!broken) return;
        const x = (side === 0 ? 1 : -1) * max.x * LAMP_SIDE_SHARE;
        parts.push({ label: `Replace ${kind} lamp · ${SIDE_NAMES[side]}`, note: 'Broken', local: new THREE.Vector3(x, midY, kind === 'head' ? max.z : min.z), fix: () => lamps.repair(kind, side) });
      });
    }
    const gearbox = vehicle.engine?.gearbox;
    if (gearbox && gearbox.health < WORN_GEARBOX) {
      parts.push({ label: 'Fix gearbox', note: `Health ${pct(gearbox.health)}`, local: new THREE.Vector3(0, min.y, (min.z + max.z) / 2), fix: () => gearbox.repair() });
    }
    return parts;
  }

  /** Viewport px of a world point, or null behind the camera. */
  function toScreen(p, rect) {
    point.set(p.x, p.y, p.z).project(camera);
    if (point.z > 1) return null;
    return { x: rect.left + ((point.x + 1) / 2) * rect.width, y: rect.top + ((1 - point.y) / 2) * rect.height };
  }

  /** Per frame, after the camera moved. */
  function update() {
    const vehicle = getVehicle();
    const speed = vehicle?.chassisBody.velocity.length() ?? Infinity;
    shown = speed < (shown ? HIDE_SPEED : SHOW_SPEED);
    if (!shown || !vehicle.wheelInfos || !vehicle.lamps) return hud.render(null);
    if (boundsFor !== vehicle) {
      bounds = localBounds(vehicle.chassisBody);
      boundsFor = vehicle;
    }
    const parts = damagedParts(vehicle);
    if (!parts.length) return hud.render(null);
    camera.updateMatrixWorld();
    const rect = canvas.getBoundingClientRect();
    const body = vehicle.chassisBody;
    chassisQuat.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    const centre = toScreen(body.position, rect);
    const views = [];
    for (const part of parts) {
      const world = part.world ?? part.local.applyQuaternion(chassisQuat).add(body.position);
      const at = toScreen(world, rect);
      if (!at) continue;
      // Away from the car's middle on screen, so a car parked off-centre still splits its cards.
      const side = centre ? (at.x < centre.x - CENTRE_PX ? -1 : 1) : undefined;
      views.push({ ...at, side, label: part.label, note: part.note, onClick: () => { part.fix(); onRepair?.(); } });
    }
    hud.render(views);
  }

  return { update };
}
