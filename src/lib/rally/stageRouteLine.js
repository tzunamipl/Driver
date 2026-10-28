// Editor line along a stage's road route (pacenotes.js stageLine): a flat ribbon of chevrons draped
// on the ground near the car, pointing the way the stage is driven. Unlit, so it reads at night too.

import { BufferAttribute, BufferGeometry, CanvasTexture, DoubleSide, Mesh, MeshBasicMaterial, RepeatWrapping, SRGBColorSpace } from 'three';
import { localToLatLon } from '../geo.js';

export const STAGE_ROUTE_COLOR = '#ffc21a';
const WIDTH_M = 0.8;
const LIFT_M = 0.15; // above the ground, clear of the road bed's triangles
const CHEVRON_M = 3; // one chevron per this much road
const RADIUS_M = 400; // drawn within this of the car
const REBUILD_MOVE_M = 40;
const REFRESH_MS = 1000; // terrain loading in under it, teleports

function chevronTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = STAGE_ROUTE_COLOR;
  ctx.globalAlpha = 0.35;
  ctx.fillRect(0, 0, 64, 64);
  ctx.globalAlpha = 1;
  // Points up the canvas = +v = the driving direction.
  ctx.beginPath();
  ctx.moveTo(4, 52);
  ctx.lineTo(32, 16);
  ctx.lineTo(60, 52);
  ctx.lineTo(60, 64);
  ctx.lineTo(32, 30);
  ctx.lineTo(4, 64);
  ctx.closePath();
  ctx.fill();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapT = RepeatWrapping;
  return texture;
}

export function createStageRouteLine({ scene, terrain, viewFrame }) {
  const material = new MeshBasicMaterial({ map: chevronTexture(), transparent: true, depthWrite: false, side: DoubleSide });
  const mesh = new Mesh(new BufferGeometry(), material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);

  let route = null; // { lat, lon, step } samples along the stage
  let visible = true;
  let builtAt = null; // { x, z, time } of the car at the last build

  function build(car) {
    builtAt = { x: car.x, z: car.z, time: performance.now() };
    const positions = [];
    const uvs = [];
    const indices = [];
    const n = route.lat.length;
    const pts = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = viewFrame.fromLatLon(route.lat[i], route.lon[i]);
      pts[i] = Math.hypot(p.x - car.x, p.z - car.z) <= RADIUS_M ? p : null;
    }
    let prev = -1; // vertex pair index of the last sample in the current run
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const y = p && terrain.surfaceHeightAt(p.x, p.z);
      if (y == null) {
        prev = -1;
        continue;
      }
      const a = pts[i - 1] ?? p;
      const b = pts[i + 1] ?? p;
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = (-(b.z - a.z) / len) * (WIDTH_M / 2);
      const nz = ((b.x - a.x) / len) * (WIDTH_M / 2);
      const v = (i * route.step) / CHEVRON_M;
      const at = positions.length / 6;
      positions.push(p.x + nx, y + LIFT_M, p.z + nz, p.x - nx, y + LIFT_M, p.z - nz);
      uvs.push(0, v, 1, v);
      if (prev >= 0) indices.push(prev * 2, prev * 2 + 1, at * 2, prev * 2 + 1, at * 2 + 1, at * 2);
      prev = at;
    }
    mesh.geometry.dispose();
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    geometry.setIndex(indices);
    mesh.geometry = geometry;
  }

  return {
    /** `line`: stageLine() result, or null for none. */
    set(line) {
      if (!line) route = null;
      else {
        const { origin, samples } = line;
        const n = samples.x.length;
        route = { lat: new Float64Array(n), lon: new Float64Array(n), step: line.step };
        for (let i = 0; i < n; i++) {
          const p = localToLatLon(samples.x[i], samples.z[i], origin.lat, origin.lon);
          route.lat[i] = p.lat;
          route.lon[i] = p.lon;
        }
      }
      builtAt = null;
    },
    setVisible(on) {
      visible = on;
      builtAt = null;
    },
    /** Per frame, with the car's position (null: none). */
    update(car) {
      mesh.visible = visible && !!route && !!car;
      if (!mesh.visible) return;
      if (builtAt && Math.hypot(car.x - builtAt.x, car.z - builtAt.z) < REBUILD_MOVE_M && performance.now() - builtAt.time < REFRESH_MS) return;
      build(car);
    },
    shiftOrigin() {
      builtAt = null;
    },
  };
}
