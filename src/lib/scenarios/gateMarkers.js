// Editor markers for scenario points: a gate (two posts + banner, arrow along travel)
// across the road, or a flag pole for non-gate points, with a label that shows through
// terrain; small coloured boards preview the roadside boards the game adds, pacenotes are
// HUD-style tiles on a post (pickable by mouse), course objects get just a label. Unlit, so
// they read at night too. Placed from scratch every sync, so no origin shift is needed.

import {
  BoxGeometry,
  CanvasTexture,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
} from 'three';
import { noteTileCanvas } from '../rally/pacenoteIcon.js';

const POST_HEIGHT_M = 4;
const POLE_HEIGHT_M = 8;
const BANNER_HEIGHT_M = 0.6;
const LABEL_HEIGHT_M = 1.6;
const LABEL_FONT_PX = 44;
const LABEL_RENDER_ORDER = 10;
const ARROW_LENGTH_M = 2.5;
const ARROW_HEIGHT_M = 0.6;
const BOARD_POST_M = 2;
const BOARD_SIZE_M = 0.9;
const NOTE_POST_M = 2.5;
const NOTE_TILE_HEIGHT_M = 3;
const TAG_HEIGHT_M = 2.2;

const postGeometry = new CylinderGeometry(0.12, 0.12, POST_HEIGHT_M, 8);
postGeometry.translate(0, POST_HEIGHT_M / 2, 0);
const poleGeometry = new CylinderGeometry(0.1, 0.1, POLE_HEIGHT_M, 8);
poleGeometry.translate(0, POLE_HEIGHT_M / 2, 0);
const postMaterial = new MeshBasicMaterial({ color: 0xeeeeee });
// Flat on the ground pointing along local -z: the travel direction.
const arrowGeometry = new ConeGeometry(0.8, ARROW_LENGTH_M, 3);
arrowGeometry.rotateX(-Math.PI / 2);
arrowGeometry.scale(1, 0.15, 1);
const arrowMaterial = new MeshBasicMaterial({ color: 0xffe400 });
const boardPostGeometry = new CylinderGeometry(0.05, 0.05, BOARD_POST_M, 6);
boardPostGeometry.translate(0, BOARD_POST_M / 2, 0);
const notePostGeometry = new CylinderGeometry(0.06, 0.06, NOTE_POST_M, 6);
notePostGeometry.translate(0, NOTE_POST_M / 2, 0);
const boardGeometry = new BoxGeometry(BOARD_SIZE_M, BOARD_SIZE_M, 0.05);
const sharedGeometries = [postGeometry, poleGeometry, arrowGeometry, boardPostGeometry, boardGeometry, notePostGeometry];

function makeLabel(text, color, selected) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `bold ${LABEL_FONT_PX}px sans-serif`;
  ctx.font = font;
  const pad = LABEL_FONT_PX * 0.35;
  canvas.width = Math.ceil(ctx.measureText(text).width + pad * 2);
  canvas.height = Math.ceil(LABEL_FONT_PX * 1.4);
  ctx.font = font;
  ctx.fillStyle = selected ? '#ffe400' : `#${color.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#000';
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  const luma = 0.299 * (color >> 16) + 0.587 * ((color >> 8) & 0xff) + 0.114 * (color & 0xff);
  ctx.fillStyle = selected || luma > 150 ? '#000' : '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, canvas.height / 2);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set((LABEL_HEIGHT_M * canvas.width) / canvas.height, LABEL_HEIGHT_M, 1);
  sprite.renderOrder = LABEL_RENDER_ORDER;
  return sprite;
}

function buildMarker(entry) {
  const { gate, board, note, width, color, label, selected } = entry;
  const group = new Group();
  if (entry.tag) {
    const sprite = makeLabel(label, color, selected);
    sprite.position.y = TAG_HEIGHT_M + LABEL_HEIGHT_M / 2;
    group.add(sprite);
    return group;
  }
  const colorMaterial = new MeshBasicMaterial({ color });
  if (board) {
    group.add(new Mesh(boardPostGeometry, postMaterial));
    const face = new Mesh(boardGeometry, colorMaterial);
    face.position.y = BOARD_POST_M;
    group.add(face);
    return group;
  }
  if (note) {
    group.add(new Mesh(notePostGeometry, postMaterial));
    const canvas = noteTileCanvas({ note, call: label, gap: entry.gap, selected, hover: entry.hover });
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const sprite = new Sprite(new SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
    sprite.scale.set((NOTE_TILE_HEIGHT_M * canvas.width) / canvas.height, NOTE_TILE_HEIGHT_M, 1);
    sprite.position.y = NOTE_POST_M + NOTE_TILE_HEIGHT_M / 2;
    sprite.renderOrder = LABEL_RENDER_ORDER;
    group.userData.pickable = sprite;
    group.add(sprite);
    return group;
  }
  if (gate) {
    for (const side of [-1, 1]) {
      const post = new Mesh(postGeometry, postMaterial);
      post.position.x = (side * width) / 2;
      group.add(post);
    }
    const banner = new Mesh(new BoxGeometry(width, BANNER_HEIGHT_M, 0.08), colorMaterial);
    banner.position.y = POST_HEIGHT_M - BANNER_HEIGHT_M / 2;
    group.add(banner);
    const arrow = new Mesh(arrowGeometry, arrowMaterial);
    arrow.position.y = ARROW_HEIGHT_M;
    group.userData.arrow = arrow;
    group.add(arrow);
  } else {
    group.add(new Mesh(poleGeometry, postMaterial));
    const flag = new Mesh(new BoxGeometry(1.6, 1, 0.05), colorMaterial);
    flag.position.set(0.8, POLE_HEIGHT_M - 0.5, 0);
    group.add(flag);
  }
  const sprite = makeLabel(label, color, selected);
  sprite.position.y = (gate ? POST_HEIGHT_M : POLE_HEIGHT_M) + LABEL_HEIGHT_M;
  group.add(sprite);
  return group;
}

function disposeMarker(group) {
  group.traverse((obj) => {
    if (obj.geometry && !sharedGeometries.includes(obj.geometry)) obj.geometry.dispose();
    if (obj.material && obj.material !== postMaterial && obj.material !== arrowMaterial) {
      obj.material.map?.dispose();
      obj.material.dispose();
    }
  });
}

export function createGateMarkers(scene) {
  const markers = new Map(); // key -> { group, signature }

  return {
    /**
     * Shows exactly these markers. Entries: { key, gate, width, color, label, selected,
     * x, y, z, dirX, dirZ } (world position; travel direction, or 0, 0 when unknown),
     * or roadside boards { key, board: true, color, x, y, z, dirX, dirZ } (facing traffic),
     * or pacenote tiles { key, note (the note), label (its call), gap, selected, hover, x, y, z },
     * or labels alone { key, tag: true, color, label, selected, x, y, z }.
     */
    sync(entries) {
      const seen = new Set();
      for (const entry of entries) {
        seen.add(entry.key);
        const noteSig = entry.note ? `${entry.note.dir}${entry.note.grade}${entry.note.junction}|${entry.gap}|${entry.hover}` : '';
        const signature = `${entry.gate}|${entry.board}|${entry.tag}|${noteSig}|${entry.width}|${entry.color}|${entry.label}|${entry.selected}`;
        let marker = markers.get(entry.key);
        if (marker?.signature !== signature) {
          if (marker) {
            scene.remove(marker.group);
            disposeMarker(marker.group);
          }
          marker = { group: buildMarker(entry), signature };
          markers.set(entry.key, marker);
          scene.add(marker.group);
        }
        marker.group.position.set(entry.x, entry.y, entry.z);
        // Local X (posts) across the road: perpendicular to (dirX, dirZ), local -z along it.
        const known = !!(entry.dirX || entry.dirZ);
        marker.group.rotation.y = known ? Math.atan2(-entry.dirX, -entry.dirZ) : 0;
        if (marker.group.userData.arrow) marker.group.userData.arrow.visible = known;
      }
      for (const [key, marker] of markers) {
        if (seen.has(key)) continue;
        scene.remove(marker.group);
        disposeMarker(marker.group);
        markers.delete(key);
      }
    },

    /** Key of the nearest pickable marker (pacenote tile) the ray hits, or null. */
    pick(raycaster) {
      let best = null;
      let bestDist = Infinity;
      for (const [key, { group }] of markers) {
        const target = group.userData.pickable;
        if (!target) continue;
        const [hit] = raycaster.intersectObject(target, false);
        if (hit && hit.distance < bestDist) {
          bestDist = hit.distance;
          best = key;
        }
      }
      return best;
    },
  };
}
