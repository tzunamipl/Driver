// Lobby vehicle preview: a slowly turning 3D model of the picked vehicle on
// its own small renderer, plus a short stats table read from the descriptor.

import * as THREE from 'three';
import { createRemoteCar, DEFAULT_ABS } from '../lib/car.js';
import { getVehicle } from '../lib/vehicles/index.js';
import { driveLabel } from '../lib/car/axles.js';
import { gearRangesOf, rangeLetters } from '../lib/engine.js';
import { sameTyreSetup, sameRims } from '../lib/tyres/setup.js';
import { isImperial, formatMass, massValue, torqueValue, torqueUnit } from '../lib/units.js';

const SPIN_RAD_PER_S = 0.6;
const CAMERA_FOV_DEG = 30;
const CAMERA_DIR = new THREE.Vector3(0.75, 0.38, 1).normalize(); // front-right quarter, slightly above
const G = 9.81;

/** [label, value] rows describing a vehicle. */
export function vehicleStats(d) {
  if (d.vehicleType === 'hover') {
    const engines = d.engineCount ?? 1;
    const totalThrustN = (d.engineThrustForce ?? 0) * engines;
    return [
      ['Engines', String(engines)],
      ['Thrust', `${Math.round(totalThrustN / 1000)} kN`],
      ['Mass', formatMass(d.mass)],
      ['Thrust/wt', (totalThrustN / (d.mass * G)).toFixed(1)],
    ];
  }
  const ranges = gearRangesOf(d);
  const mass = d.mass + (d.trailer?.mass ?? 0);
  return [
    ['Power', `${d.enginePowerHp} hp`],
    ['Torque', `${Math.round(torqueValue(d.peakTorqueNm))} ${torqueUnit()}`],
    ['Mass', formatMass(mass)],
    isImperial() ? ['Weight/power', `${(massValue(mass) / d.enginePowerHp).toFixed(1)} lb/hp`] : ['Power/wt', `${Math.round(d.enginePowerHp / (mass / 1000))} hp/t`],
    ['Drive', `${driveLabel(d)} · ${d.gearRatios?.length ?? '?'} gears`],
    ['ABS', (d.abs ?? DEFAULT_ABS) ? 'Yes' : 'No'],
    ['Traction ctrl', d.tractionControl ? 'Yes' : 'No'],
    ['Range box', ranges > 1 ? rangeLetters(ranges).join('/') : 'No'],
  ];
}

/**
 * @param {object} deps
 * @param {HTMLCanvasElement} deps.canvas
 * @param {HTMLElement} deps.statsEl
 */
export function createVehiclePreview({ canvas, statsEl }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfeeff, 0x30302a, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(4, 8, 6);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 2, 0.1, 100);

  let model = null;
  let vehicleId = null;
  let color = 0xffffff;
  let tyreSetup = null; // null: stock wheels
  let rafId = 0;
  let lastT = 0;

  // The model's group lives in `holder` (passed as its "scene"), so it spins
  // around the holder's origin once re-centred.
  const holder = new THREE.Group();
  scene.add(holder);

  function buildModel() {
    model = createRemoteCar(holder, color, '', 0, vehicleId, tyreSetup);
    const group = holder.children[0];
    // Drop the name tag so it neither shows nor skews the framing.
    const sprites = [];
    group.traverse((obj) => obj.isSprite && sprites.push(obj));
    for (const s of sprites) {
      s.parent.remove(s);
      s.material.map?.dispose();
      s.material.dispose();
    }

    // Measure unrotated: the box is in world space and the holder may be mid-spin.
    const spin = holder.rotation.y;
    holder.rotation.y = 0;
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(group);
    holder.rotation.y = spin;
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    group.position.sub(box.getCenter(new THREE.Vector3()));

    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(CAMERA_FOV_DEG) / 2)) * 0.7;
    camera.position.copy(CAMERA_DIR).multiplyScalar(dist);
    camera.lookAt(0, 0, 0);
  }

  function renderStats() {
    statsEl.innerHTML = '';
    for (const [label, value] of vehicleStats(getVehicle(vehicleId))) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      statsEl.append(dt, dd);
    }
  }

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  function frame(t) {
    rafId = requestAnimationFrame(frame);
    const dt = lastT ? Math.min((t - lastT) / 1000, 0.1) : 0;
    lastT = t;
    holder.rotation.y += SPIN_RAD_PER_S * dt;
    resize();
    renderer.render(scene, camera);
  }

  return {
    setVehicle(id) {
      const resolved = getVehicle(id).id;
      if (resolved === vehicleId && model) return;
      vehicleId = resolved;
      tyreSetup = null;
      model?.dispose();
      buildModel();
      renderStats();
    },
    /** Shows these wheel sizes + rims (tyres/setup.js) on the current vehicle. */
    setTyreSetup(next) {
      if ((sameTyreSetup(next, tyreSetup) && sameRims(next, tyreSetup)) || !vehicleId) return;
      tyreSetup = next;
      model?.dispose();
      buildModel();
    },
    setColor(next) {
      color = next;
      model?.setAppearance(color, '', 0);
    },
    start() {
      if (rafId) return;
      lastT = 0;
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(rafId);
      rafId = 0;
    },
  };
}
