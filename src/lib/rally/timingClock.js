// Digital rally clock, 1 m wide: black housing with a glowing HH:MM face of the in-game time of day.
// Every clock shares one face texture, redrawn only when the minute changes.

import { BoxGeometry, CanvasTexture, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace } from 'three';

export const CLOCK_WIDTH_M = 1;
export const CLOCK_HEIGHT_M = 0.4;
const CLOCK_DEPTH_M = 0.12;
const FACE_INSET_M = 0.04;
const DIGIT_COLOR = '#ff3b1f';
const GHOST_COLOR = '#2a0b06'; // unlit segments behind the digits

const canvas = document.createElement('canvas');
canvas.width = 512;
canvas.height = Math.round((512 * (CLOCK_HEIGHT_M - FACE_INSET_M)) / (CLOCK_WIDTH_M - FACE_INSET_M));
const ctx = canvas.getContext('2d');
const texture = new CanvasTexture(canvas);
texture.colorSpace = SRGBColorSpace;
let shownText = null;

function shared(thing) {
  thing.userData.shared = true;
  return thing;
}

const housingGeometry = shared(new BoxGeometry(CLOCK_WIDTH_M, CLOCK_HEIGHT_M, CLOCK_DEPTH_M));
const faceGeometry = shared(new PlaneGeometry(CLOCK_WIDTH_M - FACE_INSET_M, CLOCK_HEIGHT_M - FACE_INSET_M));
const housingMaterial = shared(new MeshStandardMaterial({ color: 0x141414, roughness: 0.5 }));
// Unlit and outside tone mapping: the digits glow at night.
const faceMaterial = shared(new MeshBasicMaterial({ map: texture, toneMapped: false }));

function draw(text) {
  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = `bold ${Math.round(canvas.height * 0.8)}px "Courier New", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const y = canvas.height / 2 + canvas.height * 0.04;
  ctx.fillStyle = GHOST_COLOR;
  ctx.fillText('88:88', canvas.width / 2, y);
  ctx.fillStyle = DIGIT_COLOR;
  ctx.fillText(text, canvas.width / 2, y);
  texture.needsUpdate = true;
}

/** Shows `timeMs` (simulated epoch ms) on every clock, in the player's local time zone. */
export function setClockTime(timeMs) {
  const d = new Date(timeMs);
  const text = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (text === shownText) return;
  shownText = text;
  draw(text);
}

/** A clock centred at the origin, face towards local +z. */
export function makeClock() {
  const group = new Group();
  group.add(new Mesh(housingGeometry, housingMaterial));
  const face = new Mesh(faceGeometry, faceMaterial);
  face.position.z = CLOCK_DEPTH_M / 2 + 0.005;
  group.add(face);
  return group;
}
