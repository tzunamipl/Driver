// Debug view: click a road profile dot (a terrain vertex the road bed moved)
// to draw lines to the centreline points its height blends, with a box
// at the vertex saying how it got there. Click elsewhere to clear.

import * as THREE from 'three';
import { ROAD_BED_CAUSE, ROAD_BED_CAUSE_MASK, ROAD_BED_OVERRIDE } from '../lib/terrain/roadBed.js';
import { ROAD_BED_CAUSE_LEGEND } from '../lib/terrain/tileMesh.js';

const PICK_PX = 12;
const CLICK_SLOP_PX = 5; // further than this between press and release = a drag, not a click
const OFFSET_PX = 14;

const causeLabels = Object.fromEntries(
  Object.entries(ROAD_BED_CAUSE).map(([cause, code]) => [code, ROAD_BED_CAUSE_LEGEND.find((item) => item.cause === cause).label])
);
const signed = (m) => `${m >= 0 ? '+' : ''}${m.toFixed(2)}`;

function describe({ record: { roadClass, g, h, target, edge, sources }, cause }) {
  const lines = [`${causeLabels[cause & ROAD_BED_CAUSE_MASK]} - ${roadClass}`];
  if (cause & ROAD_BED_OVERRIDE) lines.push('  over a lower road that moved it first');
  lines.push(`ground ${g.toFixed(2)} -> ${h.toFixed(2)} m (${signed(h - g)})`);
  lines.push(`road top ${target.toFixed(2)} m, ${edge <= 0 ? 'node on the road' : `node ${edge.toFixed(1)} m past its edge`}`);
  lines.push(`from ${sources.length / 5} centreline point(s):`);
  const points = [];
  for (let k = 0; k < sources.length; k += 5) points.push(sources.slice(k, k + 5));
  points.sort((a, b) => b[3] - a[3]);
  for (const [, road, , weight, ground] of points) {
    lines.push(`  ${(weight * 100).toFixed(0).padStart(3)}%  road ${road.toFixed(2)}, its ground ${ground.toFixed(2)} (${signed(road - ground)})`);
  }
  return lines.join('\n');
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.el - info box element
 * @param {HTMLCanvasElement} deps.canvas - the renderer's canvas
 * @param {THREE.Camera} deps.camera
 * @param {import('../lib/terrain.js').TerrainManager} deps.terrain
 */
export function createRoadBedInspect({ el, canvas, camera, terrain }) {
  const screen = new THREE.Vector3();
  let press = null;
  let shownRecord = null;

  window.addEventListener('pointerdown', (e) => {
    press = e.pointerType === 'mouse' && e.button === 0 && e.target === canvas ? { x: e.clientX, y: e.clientY } : null;
  });
  window.addEventListener('pointerup', (e) => {
    if (!press || e.target !== canvas || Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP_PX) return;
    press = null;
    if (!terrain.roadProfileVisible) return;
    const rect = canvas.getBoundingClientRect();
    terrain.inspectRoadBedAt(camera, e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height, PICK_PX);
  });

  function frame() {
    requestAnimationFrame(frame);
    const inspection = terrain.getRoadBedInspection();
    if (inspection?.shown) screen.copy(inspection.position).project(camera);
    if (!inspection?.shown || screen.z > 1) {
      el.style.display = 'none';
      return;
    }
    if (inspection.record !== shownRecord) {
      shownRecord = inspection.record;
      el.textContent = describe(inspection);
    }
    const rect = canvas.getBoundingClientRect();
    el.style.left = `${rect.left + ((screen.x + 1) / 2) * rect.width + OFFSET_PX}px`;
    el.style.top = `${rect.top + ((1 - screen.y) / 2) * rect.height + OFFSET_PX}px`;
    el.style.display = 'block';
  }
  frame();
}
