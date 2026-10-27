// Brake disc + caliper (or a drum) behind the rim, on its own group that steers with the wheel
// but doesn't spin (car.js syncs it). A hot disc glows dull red to orange-yellow.

import * as THREE from 'three';

const SEGMENTS = 18;
const DISC_COLOR = 0x8c8c8e;
const HAT_COLOR = 0x5a5a5c;
const DRUM_COLOR = 0x3a3a3c;
const CALIPER_COLORS = { road: 0x2a2a2c, race: 0xc0201c };
// The disc fits inside the rim's face edge (rimMesh.js FACE_EDGE) with this share.
const MAX_RADIUS_SHARE = 0.8;
// Centre plane, share of the rim width inboard of the wheel's middle.
const INBOARD_SHARE = 0.1;
const HAT_SHARE = 0.45;
// Glow from this temperature (°C), full at the second; colour ramp dull red -> orange -> yellow.
const GLOW_FROM_C = 420;
const GLOW_FULL_C = 900;
const GLOW_RAMP = [new THREE.Color(0x5a0800), new THREE.Color(0xff3a00), new THREE.Color(0xffa040)];
const GLOW_INTENSITY = 2.2;
const GLOW_STEP_C = 10; // recolour only on a visible change

/**
 * Brake hardware for one wheel position. `unit`: lib/brakes.js brakeUnit(); `rimRadius` / `rimWidth` (m);
 * `side` +1 left, -1 right (inboard is -side on x). Returns a group with userData.brake for setBrakeGlow.
 */
export function buildBrakeMesh(unit, rimRadius, rimWidth, side, pads = 'road') {
  const group = new THREE.Group();
  const x = -side * rimWidth * INBOARD_SHARE;
  const mats = [];
  if (unit.type === 'drum') {
    const r = Math.min(unit.diameterM / 2 + 0.01, rimRadius * MAX_RADIUS_SHARE);
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(r, r, Math.min(unit.width, rimWidth * 0.6), SEGMENTS), new THREE.MeshStandardMaterial({ color: DRUM_COLOR, roughness: 0.8, metalness: 0.3 }));
    drum.rotation.z = Math.PI / 2;
    drum.position.x = x;
    group.add(drum);
  } else {
    const r = Math.min(unit.diameterM / 2, rimRadius * MAX_RADIUS_SHARE);
    const t = Math.min(unit.thickness, rimWidth * 0.25);
    const discMat = new THREE.MeshStandardMaterial({ color: DISC_COLOR, roughness: 0.45, metalness: 0.4, emissive: 0x000000 });
    mats.push(discMat);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(r, r, t, SEGMENTS), discMat);
    disc.rotation.z = Math.PI / 2;
    disc.position.x = x;
    const hat = new THREE.Mesh(new THREE.CylinderGeometry(r * HAT_SHARE, r * HAT_SHARE, t * 1.6, SEGMENTS), new THREE.MeshStandardMaterial({ color: HAT_COLOR, roughness: 0.6, metalness: 0.3 }));
    hat.rotation.z = Math.PI / 2;
    hat.position.x = x + side * t * 0.4;
    // Caliper astride the disc's rear-upper edge.
    const caliper = new THREE.Mesh(
      new THREE.BoxGeometry(t + 0.035, r * 0.42, r * 0.28),
      new THREE.MeshStandardMaterial({ color: CALIPER_COLORS[pads] ?? CALIPER_COLORS.road, roughness: 0.5, metalness: 0.2 })
    );
    const a = Math.PI * 0.75; // from +z (forward) round to the rear-upper quarter
    caliper.position.set(x, Math.sin(a) * r * 0.82, Math.cos(a) * r * 0.82);
    caliper.rotation.x = a - Math.PI / 2; // long side along the rim
    group.add(disc, hat, caliper);
  }
  group.userData.brake = { mats, glowC: null };
  return group;
}

/** Glows the disc by its temperature (°C). */
export function setBrakeGlow(group, tempC) {
  const brake = group.userData.brake;
  if (!brake?.mats.length) return;
  const stepped = Math.round(tempC / GLOW_STEP_C) * GLOW_STEP_C;
  if (brake.glowC === stepped) return;
  brake.glowC = stepped;
  const t = Math.min(1, Math.max(0, (stepped - GLOW_FROM_C) / (GLOW_FULL_C - GLOW_FROM_C)));
  for (const m of brake.mats) {
    if (t <= 0) {
      m.emissive.setHex(0x000000);
      m.emissiveIntensity = 0;
      continue;
    }
    const k = t * (GLOW_RAMP.length - 1);
    const i = Math.min(GLOW_RAMP.length - 2, Math.floor(k));
    m.emissive.lerpColors(GLOW_RAMP[i], GLOW_RAMP[i + 1], k - i);
    m.emissiveIntensity = GLOW_INTENSITY * t ** 1.3;
  }
}

export function disposeBrakeMesh(group) {
  group.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.geometry.dispose();
    obj.material.dispose();
  });
}
