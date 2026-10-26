import * as THREE from 'three';
import { createPaintMaterial } from './paint.js';
import { truckMaterials } from './euroCab.js';
import { createKit } from './kit.js';

// Hummel: light cab-over flatbed tow truck (laweta), low-poly: narrow
// tilt cab with a beacon bar, headboard + winch, aluminium deck with a
// sloped tail, underlift at the back. Chassis-local, +z forward, 7.2 m
// long; ground near y = -0.88. Axle positions must match ../hummel.js.

export const AXLES_Z = [2.5, -1.2];
const FRONT = 3.6;
const BACK = -3.6;
const WIDTH = 2.25;
const CAB_DEPTH = 1.7;

/** `color` paints the cab and deck rails; the deck stays aluminium. */
export function buildBody(_chassisWidth, _chassisLength, color = 0xf2b705) {
  const group = new THREE.Group();
  const m = truckMaterials();
  const bodyMat = createPaintMaterial(color, { metalness: 0.2, roughness: 0.45 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0xa4a8ac, metalness: 0.75, roughness: 0.45 });
  const kit = createKit(group);
  const { box, tube, fender } = kit;

  // Cab: box over the front axle, windscreen, side glass, mirrors on arms.
  const cabBottom = -0.15;
  const roofY = 1.85;
  const cabZ = FRONT - CAB_DEPTH / 2;
  box(WIDTH, roofY - cabBottom, CAB_DEPTH, bodyMat, 0, (roofY + cabBottom) / 2, cabZ);
  box(WIDTH - 0.2, 0.8, 0.04, m.glass, 0, 1.28, FRONT + 0.01);
  box(WIDTH + 0.02, 0.1, 0.04, m.plastic, 0, 0.84, FRONT + 0.02); // wiper cowl
  for (const sx of [-1, 1]) {
    box(0.04, 0.65, 0.85, m.glass, sx * (WIDTH / 2 + 0.01), 1.28, FRONT - 0.5);
    box(0.05, 0.05, 0.35, m.plastic, sx * (WIDTH / 2 + 0.15), 1.6, FRONT - 0.15);
    box(0.05, 0.45, 0.22, m.plastic, sx * (WIDTH / 2 + 0.32), 1.4, FRONT - 0.12);
    box(0.03, 0.4, 0.16, m.glass, sx * (WIDTH / 2 + 0.32), 1.4, FRONT - 0.1);
    box(0.3, 0.04, 0.3, m.steel, sx * (WIDTH / 2 - 0.2), -0.3, FRONT - CAB_DEPTH + 0.2); // step
    fender(0.45, 0.32, m.plastic, sx * 0.88, -0.5, AXLES_Z[0]);
  }
  box(1.5, 0.45, 0.04, m.frame, 0, 0.45, FRONT + 0.015); // grille
  for (let i = 0; i < 4; i++) box(1.4, 0.04, 0.03, m.steel, 0, 0.3 + i * 0.1, FRONT + 0.04);

  // Front bumper below the cab with headlamps; amber beacon bar on the roof.
  box(WIDTH + 0.02, 0.5, 0.3, m.plastic, 0, -0.4, FRONT - 0.13);
  for (const sx of [-1, 1]) {
    box(0.4, 0.16, 0.04, m.head, sx * 0.78, -0.3, FRONT + 0.03);
    box(0.14, 0.08, 0.04, m.amber, sx * 1.02, -0.3, FRONT + 0.03);
  }
  box(1.3, 0.06, 0.22, m.frame, 0, roofY + 0.03, FRONT - 0.35);
  box(1.2, 0.12, 0.2, m.amber, 0, roofY + 0.12, FRONT - 0.35);

  // Ladder frame, fuel tank, battery box.
  for (const sx of [-1, 1]) box(0.16, 0.25, 6.6, m.frame, sx * 0.42, -0.35, -0.2);
  tube(0.25, 0.8, m.steel, 0.8, -0.45, 0.6);
  box(0.5, 0.4, 0.5, m.plastic, -0.85, -0.4, 0.6);

  // Deck: subframe, flat bed, sloped tail, side rails in body colour.
  const deckFront = FRONT - CAB_DEPTH - 0.15;
  const rampLen = 0.7;
  const flatLen = deckFront - (BACK + rampLen);
  const flatZ = deckFront - flatLen / 2;
  const deckY = 0.16;
  box(1.0, 0.16, deckFront - BACK - 0.2, m.frame, 0, -0.05, (deckFront + BACK) / 2 + 0.1);
  box(2.3, 0.08, flatLen, deckMat, 0, deckY, flatZ);
  const slope = 0.28;
  const ramp = box(2.3, 0.06, rampLen, deckMat, 0, deckY - (rampLen / 2) * Math.sin(slope), BACK + rampLen / 2);
  ramp.rotation.x = -slope;
  for (const sx of [-1, 1]) box(0.08, 0.12, flatLen, bodyMat, sx * 1.15, deckY + 0.06, flatZ);
  for (let i = 1; i < 6; i++) box(2.2, 0.012, 0.05, m.frame, 0, deckY + 0.045, deckFront - i * (flatLen / 6)); // tread strips

  // Headboard with work lamps, winch at the deck front, wheel chocks.
  box(2.2, 0.85, 0.08, bodyMat, 0, deckY + 0.45, deckFront + 0.02);
  for (const sx of [-1, 1]) box(0.2, 0.12, 0.05, m.head, sx * 0.7, deckY + 0.8, deckFront - 0.03);
  box(0.6, 0.28, 0.35, m.frame, 0, deckY + 0.18, deckFront - 0.3);
  tube(0.1, 0.5, m.steel, 0, deckY + 0.2, deckFront - 0.3).rotation.y = Math.PI / 2;
  for (const sx of [-1, 1]) box(0.25, 0.12, 0.18, bodyMat, sx * 0.8, deckY + 0.1, -2.2);

  // Rear: mud flaps, light bar under the deck tail, underlift.
  for (const sx of [-1, 1]) {
    box(0.55, 0.45, 0.04, m.frame, sx * 0.78, -0.5, AXLES_Z[1] - 0.55);
    box(0.3, 0.12, 0.05, m.tail, sx * 0.9, -0.25, BACK + 0.12);
    box(0.12, 0.12, 0.05, m.amber, sx * 0.6, -0.25, BACK + 0.12);
  }
  box(2.2, 0.16, 0.1, m.steel, 0, -0.25, BACK + 0.2);
  box(0.25, 0.14, 0.6, m.frame, 0, -0.55, BACK + 0.1);
  box(1.5, 0.12, 0.14, bodyMat, 0, -0.55, BACK - 0.15);

  return { group, bodyMat };
}
