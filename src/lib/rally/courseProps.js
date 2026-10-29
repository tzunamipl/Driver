// Course objects authors place on stages / rallies (scenario `objects`): round hay bales
// standing on end (solid), red-white tape on stakes and red-white warning signs (both knock over). Builders
// return meshes in the object's frame: local +z faces back along its heading (towards cars
// approaching along it), local +x is its right. Physics specs ride on userData: `solid`
// (static collider) or `knock` (knockable.js trigger + debris).

import { CanvasTexture, CircleGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshStandardMaterial, PlaneGeometry, RepeatWrapping, SRGBColorSpace } from 'three';
import * as CANNON from 'cannon-es';
import { bakeProps, paint } from './zoneProps.js';
import { SIGN_HIT_GAIN } from '../audio/postHit.js';

const BALE_RADIUS_M = 0.75;
const BALE_HEIGHT_M = 1.2;
const BALE_SEGMENTS = 12;
export const TAPE_STAKE_SPACING_M = 3;
export const TAPE_HEIGHT_M = 0.85;
const TAPE_WIDTH_M = 0.07;
const TAPE_STRIPE_M = 0.25; // one red + one white diagonal stripe
const STAKE_HEIGHT_M = 1.1;
const STAKE_HALF_M = 0.04;
const SIGN_WIDTH_M = 1.1;
const SIGN_HEIGHT_M = 0.4;
const SIGN_CENTRE_M = 0.85;
const SIGN_LEG_M = SIGN_CENTRE_M + SIGN_HEIGHT_M / 2;

function shared(thing) {
  thing.userData.shared = true;
  return thing;
}

/** Red and white stripes at 45°, `stripes` pairs across the canvas width. */
function stripeTexture(width, height, stripes) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4f4f4';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#d71e1e';
  const pair = width / stripes;
  for (let x = -height; x < width + height; x += pair) {
    ctx.beginPath();
    ctx.moveTo(x, height);
    ctx.lineTo(x + pair / 2, height);
    ctx.lineTo(x + pair / 2 + height, 0);
    ctx.lineTo(x + height, 0);
    ctx.fill();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

// Drawn on first use, not at import.
let tapeMaterial = null;
let signMaterial = null;

function tapeMaterialOnce() {
  if (!tapeMaterial) {
    const texture = stripeTexture(64, 16, 1);
    texture.wrapS = RepeatWrapping;
    tapeMaterial = shared(new MeshStandardMaterial({ map: texture, side: DoubleSide, roughness: 0.5 }));
  }
  return tapeMaterial;
}

function signMaterialOnce() {
  signMaterial ??= shared(new MeshStandardMaterial({ map: stripeTexture(256, 96, 5), roughness: 0.4 }));
  return signMaterial;
}
const signGeometry = shared(new PlaneGeometry(SIGN_WIDTH_M, SIGN_HEIGHT_M));
const mat = {
  straw: paint(0xc9a24a),
  strawEnd: paint(0xa88434),
  net: paint(0xe6e0c8),
  white: paint(0xf2f2f2),
  red: paint(0xd71e1e),
  steel: paint(0x9a9a9a),
  black: paint(0x161616),
};

/** Round bale standing on one flat end; a static upright cylinder collider. */
export function makeHayBale() {
  const group = new Group();
  const body = new Mesh(new CylinderGeometry(BALE_RADIUS_M, BALE_RADIUS_M, BALE_HEIGHT_M, 18, 1, true), mat.straw);
  body.position.y = BALE_HEIGHT_M / 2;
  group.add(body);
  // Net wrap bands near both ends; the top face darker where the roll shows.
  for (const y of [0.15, BALE_HEIGHT_M - 0.15]) {
    const band = new Mesh(new CylinderGeometry(BALE_RADIUS_M + 0.01, BALE_RADIUS_M + 0.01, 0.12, 18, 1, true), mat.net);
    band.position.y = y;
    group.add(band);
  }
  const top = new Mesh(new CircleGeometry(BALE_RADIUS_M, 18), mat.strawEnd);
  top.rotation.x = -Math.PI / 2;
  top.position.y = BALE_HEIGHT_M;
  const core = new Mesh(new CircleGeometry(BALE_RADIUS_M * 0.35, 12), mat.straw);
  core.rotation.x = -Math.PI / 2;
  core.position.y = BALE_HEIGHT_M + 0.005;
  group.add(top, core);
  const mesh = bakeProps(group);
  mesh.userData.solid = { center: [0, BALE_HEIGHT_M / 2, 0], shape: new CANNON.Cylinder(BALE_RADIUS_M, BALE_RADIUS_M, BALE_HEIGHT_M, BALE_SEGMENTS) };
  return mesh;
}

/** Tape stake: white post with a red top; the tape spans hang between them (makeTapeSpan). */
export function makeTapeStake() {
  const group = new Group();
  const post = new Mesh(new CylinderGeometry(0.025, 0.03, STAKE_HEIGHT_M, 6), mat.white);
  post.position.y = STAKE_HEIGHT_M / 2;
  const top = new Mesh(new CylinderGeometry(0.027, 0.027, 0.15, 6), mat.red);
  top.position.y = STAKE_HEIGHT_M - 0.075;
  group.add(post, top);
  const mesh = bakeProps(group);
  mesh.userData.knock = {
    center: [0, STAKE_HEIGHT_M / 2, 0],
    shape: new CANNON.Box(new CANNON.Vec3(STAKE_HALF_M, STAKE_HEIGHT_M / 2, STAKE_HALF_M)),
    mass: 1.5,
    debrisRadius: 0.04,
    debrisSpheres: [[0, -STAKE_HEIGHT_M * 0.4, 0], [0, STAKE_HEIGHT_M * 0.4, 0]],
  };
  return mesh;
}

/** Tape ribbon along local +x from 0 to `length`, stripes at their true size; scale.x stretches it. */
export function makeTapeSpan(length) {
  const geometry = new PlaneGeometry(length, TAPE_WIDTH_M);
  geometry.translate(length / 2, 0, 0);
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, (uv.getX(i) * length) / TAPE_STRIPE_M);
  const mesh = new Mesh(geometry, tapeMaterialOnce());
  mesh.castShadow = true;
  return mesh;
}

/** Trigger box for a tape span `length` long, centred on it (local x along the tape). */
export const tapeSpanShape = (length) => new CANNON.Box(new CANNON.Vec3(length / 2, 0.3, 0.05));

/** Warning sign: red-white striped board on a two-legged stand, facing local +z. */
export function makeWarningSign() {
  const group = new Group();
  const frame = new Group();
  for (const s of [-1, 1]) {
    const leg = new Mesh(new CylinderGeometry(0.025, 0.025, SIGN_LEG_M, 6), mat.steel);
    leg.position.set(s * (SIGN_WIDTH_M / 2 - 0.1), SIGN_LEG_M / 2, -0.03);
    const foot = new Mesh(new CylinderGeometry(0.03, 0.03, 0.6, 6), mat.black);
    foot.rotation.x = Math.PI / 2;
    foot.position.set(s * (SIGN_WIDTH_M / 2 - 0.1), 0.03, -0.03);
    frame.add(leg, foot);
  }
  const back = new Mesh(new PlaneGeometry(SIGN_WIDTH_M, SIGN_HEIGHT_M), mat.steel);
  back.rotation.y = Math.PI;
  back.position.set(0, SIGN_CENTRE_M, -0.005);
  frame.add(back);
  group.add(bakeProps(frame));
  const face = new Mesh(signGeometry, signMaterialOnce());
  face.position.set(0, SIGN_CENTRE_M, 0);
  group.add(face);
  group.userData.knock = {
    center: [0, SIGN_LEG_M / 2, 0],
    shape: new CANNON.Box(new CANNON.Vec3(SIGN_WIDTH_M / 2, SIGN_LEG_M / 2, 0.3)),
    mass: 6,
    hitSound: 'metal',
    hitGain: SIGN_HIT_GAIN,
    debrisRadius: 0.08,
    debrisSpheres: [[-0.45, -0.4, 0], [0.45, -0.4, 0], [-0.45, 0.4, 0], [0.45, 0.4, 0]],
  };
  return group;
}
