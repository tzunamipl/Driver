// Floating repair buttons on the car's parts (hud/repairCallouts.js) while it is nearly
// stopped: places each item's anchor on the car on screen. Used by free roam's roadside
// repairs (app/roadsideRepair.js) and the rally field fixes (app/rally/fieldRepair.js).

import * as THREE from 'three';
import { createRepairCallouts } from '../hud/repairCallouts.js';

// m/s: shown once this slow, kept until faster than the second (no flicker at walking pace).
const SHOW_SPEED = 0.8;
const HIDE_SPEED = 1.5;
const LAMP_SIDE_SHARE = 0.7; // lamp anchors this far out of the body's half width
const CIRCUIT_SHARE = 0.55; // brake pipe anchors this far out of the body's half length
const CENTRE_PX = 30; // parts this close to the car's middle on screen put their card right (no flip-flop)

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
 * Anchors: { wheel: i } (its centre), { shock: i } (its top mount), { lamp: 'head' | 'tail', side }, { circuit: 'front' | 'rear' } (brake pipe under that end),
 * 'front' (radiator), 'engine' (under the bonnet), 'under' (the floor's middle), 'filler' (left rear quarter),
 * 'exhaust' (vehicle.exhaust.anchor, else the rear bottom), { local: [x, y, z] } (a chassis-local point).
 * @param {object} deps
 * @param {HTMLCanvasElement} deps.canvas
 * @param {THREE.Camera} deps.camera
 */
export function createPartCallouts({ canvas, camera }) {
  const hud = createRepairCallouts();
  const point = new THREE.Vector3();
  const local = new THREE.Vector3();
  const chassisQuat = new THREE.Quaternion();
  let bounds = null;
  let boundsFor = null;
  let shown = false;

  function anchorWorld(vehicle, anchor) {
    if (anchor.wheel != null) return vehicle.wheelInfos[anchor.wheel].worldTransform.position;
    if (anchor.shock != null) return vehicle.wheelInfos[anchor.shock].connectionPointWorld;
    const { min, max } = bounds;
    const midY = (min.y + max.y) / 2;
    if (anchor.local) local.fromArray(anchor.local);
    else if (anchor.lamp) local.set((anchor.side === 0 ? 1 : -1) * max.x * LAMP_SIDE_SHARE, midY, anchor.lamp === 'head' ? max.z : min.z);
    else if (anchor.circuit) local.set(0, min.y, (anchor.circuit === 'front' ? max.z : min.z) * CIRCUIT_SHARE);
    else if (anchor === 'front') local.set(0, midY, max.z);
    else if (anchor === 'engine') local.set(0, max.y, max.z * 0.6);
    else if (anchor === 'under') local.set(0, min.y, (min.z + max.z) / 2);
    else if (anchor === 'exhaust') {
      const at = vehicle.exhaust?.anchor;
      if (at) local.set(at[0], at[1], at[2]);
      else local.set(max.x * 0.5, min.y, min.z);
    }
    else local.set(max.x, midY, min.z * 0.6); // filler
    const body = vehicle.chassisBody;
    return local.applyQuaternion(chassisQuat).add(body.position);
  }

  /** Viewport px of a world point, or null behind the camera. */
  function toScreen(p, rect) {
    point.set(p.x, p.y, p.z).project(camera);
    if (point.z > 1) return null;
    return { x: rect.left + ((point.x + 1) / 2) * rect.width, y: rect.top + ((1 - point.y) / 2) * rect.height };
  }

  /**
   * Per frame, after the camera moved. `getItems(vehicle)` is asked only while stopped:
   * [{ anchor, label, note?, disabled?, onClick }]. A null vehicle hides them.
   */
  function update(vehicle, getItems) {
    const speed = vehicle?.chassisBody.velocity.length() ?? Infinity;
    shown = speed < (shown ? HIDE_SPEED : SHOW_SPEED);
    if (!shown || !vehicle.wheelInfos) return hud.render(null);
    const items = getItems(vehicle);
    if (!items.length) return hud.render(null);
    if (boundsFor !== vehicle) {
      bounds = localBounds(vehicle.chassisBody);
      boundsFor = vehicle;
    }
    camera.updateMatrixWorld();
    const rect = canvas.getBoundingClientRect();
    const body = vehicle.chassisBody;
    chassisQuat.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    const centre = toScreen(body.position, rect);
    const views = [];
    for (const item of items) {
      const at = toScreen(anchorWorld(vehicle, item.anchor), rect);
      if (!at) continue;
      // Away from the car's middle on screen, so a car parked off-centre still splits its cards.
      const side = centre ? (at.x < centre.x - CENTRE_PX ? -1 : 1) : undefined;
      views.push({ ...at, side, label: item.label, note: item.note, disabled: item.disabled, onClick: item.onClick });
    }
    hud.render(views);
  }

  return { update };
}
