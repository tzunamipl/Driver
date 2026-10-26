// Tyre service preview: a slowly turning 3D wheel of a tyre setup on its own small renderer,
// sized against the vehicle's stock wheel and wrapped in a tread pattern per compound; a used
// tyre's condition fades the grooves with wear and browns it with dirt.

import * as THREE from 'three';
import { buildWheelMesh } from '../lib/car/wheelMesh.js';
import { getVehicle } from '../lib/vehicles/index.js';
import { stockTyreSetup, sameTyreSetup, sameRims } from '../lib/tyres/setup.js';
import { resolveRim } from '../lib/car/rims.js';

const SPIN_RAD_PER_S = 0.7;
const CAMERA_FOV_DEG = 30;
const CAMERA_DIR = new THREE.Vector3(0.9, 0.35, 0.6).normalize();
// Frame size vs the stock tyre's diameter, so bigger / smaller setups read as such.
const FRAME_SCALE = 1.5;
const TEX_W = 256;
const TEX_H = 64;
// Tread pattern repeats around the circumference.
const TREAD_REPEAT = 3;
// Smoother than the in-game wheel: it fills the preview.
const WHEEL_SEGMENTS = 32;
const RUBBER = '#2b2b2b';
const GROOVE = '#070707';
const STUD = '#c8c8c8';
const MUD = '#6b4a2b';
// Dirt at which the tread is fully browned (then the sidewalls brown), as in wheelMesh.js.
const TREAD_BROWN_AT = 0.5;
const MUD_COVER = 0.65; // mud's opacity on a fully browned tread
const BALD_FADE = 0.85; // share of the groove contrast gone at 0 tread
const SIDE_TYRE = new THREE.Color(0x1a1a1a);
const SIDE_MUD = new THREE.Color(MUD);

// Pattern per compound id; unlisted compounds get the road pattern.
const TREAD_PATTERNS = {
  slickSoft: 'slick',
  slickHard: 'slick',
  semiSlickSoft: 'semiSlick',
  semiSlickHard: 'semiSlick',
  wetSoft: 'wet',
  wetHard: 'wet',
  gravelSoft: 'gravel',
  gravelHard: 'gravel',
  road: 'road',
  allTerrain: 'allTerrain',
  mud: 'mud',
  snow: 'snow',
  ice: 'ice',
  sand: 'sand',
};

// Each draws onto a TEX_W x TEX_H canvas: x around the tyre, y across its width.
const DRAW = {
  slick() {},
  semiSlick(g) {
    g.fillRect(0, 20, TEX_W, 4);
    g.fillRect(0, 40, TEX_W, 4);
    for (let x = 0; x < TEX_W; x += 32) g.fillRect(x, 44, 3, 20);
  },
  road(g) {
    for (const y of [12, 26, 38, 52]) g.fillRect(0, y - 2, TEX_W, 4);
    for (let x = 0; x < TEX_W; x += 16) {
      g.fillRect(x, 0, 2, 10);
      g.fillRect(x + 8, 54, 2, 10);
    }
  },
  wet(g) {
    g.lineWidth = 5;
    for (let x = -32; x < TEX_W + 32; x += 24) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x + 20, TEX_H / 2);
      g.lineTo(x, TEX_H);
      g.stroke();
    }
    g.fillRect(0, TEX_H / 2 - 3, TEX_W, 6);
  },
  gravel(g) {
    blocks(g, 16, 13, 4, 4);
  },
  allTerrain(g) {
    blocks(g, 22, 16, 5, 5);
    g.fillRect(0, TEX_H / 2 - 2, TEX_W, 4);
  },
  mud(g) {
    blocks(g, 32, 21, 10, 10);
  },
  snow(g) {
    blocks(g, 18, 13, 4, 4);
    g.fillStyle = GROOVE;
    for (let x = 4; x < TEX_W; x += 6) g.fillRect(x, 0, 1, TEX_H);
  },
  ice(g) {
    blocks(g, 18, 13, 4, 4);
    g.fillStyle = STUD;
    for (let row = 0; row * 17 < TEX_H; row++) for (let x = 6 + (row % 2) * 11; x < TEX_W; x += 22) g.fillRect(x, 6 + row * 17, 3, 3);
  },
  sand(g) {
    // Paddles: rubber bars across the tread, wide gaps between.
    for (let x = 0; x < TEX_W; x += 32) g.fillRect(x + 8, 0, 24, TEX_H);
  },
};

/** Grooves around staggered blocks of `w` x `h` with `gapX` / `gapY` gaps. */
function blocks(g, w, h, gapX, gapY) {
  g.fillRect(0, 0, TEX_W, TEX_H);
  g.fillStyle = RUBBER;
  for (let row = 0, y = gapY / 2; y < TEX_H; row++, y += h + gapY) {
    const shift = row % 2 ? (w + gapX) / 2 : 0;
    for (let x = -w + shift; x < TEX_W; x += w + gapX) g.fillRect(x, y, w, h);
  }
  g.fillStyle = GROOVE;
}

const textures = new Map(); // pattern -> CanvasTexture of a new tyre

/** Tread texture for a compound; `condition` { tread, dirt } draws a used one (not cached). */
function treadTexture(compoundId, condition = null) {
  const pattern = TREAD_PATTERNS[compoundId] ?? 'road';
  if (!condition && textures.has(pattern)) return textures.get(pattern);
  const canvas = Object.assign(document.createElement('canvas'), { width: TEX_W, height: TEX_H });
  const g = canvas.getContext('2d');
  g.fillStyle = RUBBER;
  g.fillRect(0, 0, TEX_W, TEX_H);
  g.fillStyle = GROOVE;
  g.strokeStyle = GROOVE;
  DRAW[pattern](g);
  if (condition) {
    g.globalAlpha = (1 - (condition.tread ?? 1)) * BALD_FADE;
    g.fillStyle = RUBBER;
    g.fillRect(0, 0, TEX_W, TEX_H);
    g.globalAlpha = Math.min(1, (condition.dirt ?? 0) / TREAD_BROWN_AT) * MUD_COVER;
    g.fillStyle = MUD;
    g.fillRect(0, 0, TEX_W, TEX_H);
    g.globalAlpha = 1;
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(TREAD_REPEAT, 1);
  if (!condition) textures.set(pattern, tex);
  return tex;
}

/** @param {HTMLCanvasElement} canvas */
export function createTyrePreview(canvas) {
  let renderer = null; // made on first start, so a game that never services opens no extra context
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfeeff, 0x30302a, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(4, 6, 5);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV_DEG, 1, 0.05, 20);
  const holder = new THREE.Group();
  scene.add(holder);

  let wheel = null;
  let usedTexture = null; // this preview's own texture of a used tyre
  let shown = null; // { vehicleId, setup, key }
  let rafId = 0;
  let lastT = 0;

  function disposeWheel() {
    if (!wheel) return;
    holder.remove(wheel);
    wheel.traverse((obj) => {
      obj.geometry?.dispose();
      for (const m of [obj.material].flat()) m?.dispose(); // new-tyre textures are shared, kept
    });
    usedTexture?.dispose();
    usedTexture = null;
    wheel = null;
  }

  function build(vehicleId, setup, condition) {
    disposeWheel();
    const descriptor = getVehicle(vehicleId);
    const rim = resolveRim({ ...descriptor, tyreCompound: setup.compound, tyreSetup: setup });
    wheel = buildWheelMesh({ rimSize: setup.rimSize, tyre: setup.width, profile: setup.profile, ...rim }, holder, WHEEL_SEGMENTS);
    const map = treadTexture(setup.compound, condition);
    if (condition) usedTexture = map;
    for (const m of wheel.userData.tyreMats.tread) {
      m.map = map;
      m.color.set(0xffffff);
    }
    const sideMud = Math.max(0, ((condition?.dirt ?? 0) - TREAD_BROWN_AT) / (1 - TREAD_BROWN_AT));
    for (const m of wheel.userData.tyreMats.side) m.color.lerpColors(SIDE_TYRE, SIDE_MUD, sideMud);
    const stock = stockTyreSetup(descriptor);
    const stockRadius = (stock.rimSize * 2.54) / 200 + ((stock.width / 1000) * stock.profile) / 100;
    const dist = (stockRadius * FRAME_SCALE) / Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV_DEG) / 2);
    camera.position.copy(CAMERA_DIR).multiplyScalar(dist);
    camera.lookAt(0, 0, 0);
  }

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h || canvas.width === Math.round(w * renderer.getPixelRatio())) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
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
    /**
     * Shows this setup (tyres/setup.js) on the vehicle's wheel; new, or used with `condition` { tread, dirt } (0..1).
     */
    show(vehicleId, setup, condition = null) {
      const key = condition ? `${condition.tread.toFixed(2)}|${condition.dirt.toFixed(2)}` : '';
      if (shown && shown.vehicleId === vehicleId && shown.key === key && sameTyreSetup(shown.setup, setup) && sameRims(shown.setup, setup)) return;
      shown = { vehicleId, setup, key };
      build(vehicleId, setup, condition);
    },
    start() {
      if (rafId) return;
      if (!renderer) {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
      }
      lastT = 0;
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      cancelAnimationFrame(rafId);
      rafId = 0;
    },
  };
}
