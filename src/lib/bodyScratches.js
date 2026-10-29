// Paint scratches of the own car: up to MAX_PATCHES patches in body space, each a streaky
// ellipse stretched along the way the body slid over the obstacle. Hits and scrapes against
// buildings / the ground deepen a patch through the clear coat (scuffed) to bare metal. Drawn in the body paint shader under the dirt (bodyDirt.js); saved with the
// car damage, cleared by repair() or a respray, scuffs polished out by polish().

import * as THREE from 'three';
import * as CANNON from 'cannon-es';

const MAX_PATCHES = 32;
// Baked paint coords of body part i (0 chassis, 1 trailer) sit i x this far along x, so a patch on one never reaches the other.
export const PART_OFFSET_M = 100;
const HIT_MIN_MS = 1.5; // impact speed along the normal that starts to mark
const HIT_FULL_MS = 12; // ... and the one that goes to bare metal at once
const SLIDE_MIN_MS = 1; // slower sliding along an obstacle leaves nothing
// Per metre slid, per contact (a scrape fires a few contacts a step).
const SCRAPE_DEPTH_PER_M = 0.015;
const SCRAPE_STRETCH_PER_M = 0.1;
const MIN_HALF_LENGTH_M = 0.15;
const MAX_HALF_LENGTH_M = 1.5;
const MIN_HALF_WIDTH_M = 0.12;
const MAX_HALF_WIDTH_M = 0.5;
const HIT_LENGTH_M = 0.5; // added half length at full severity
const HIT_WIDTH_M = 0.3; // added half width at full severity
const MERGE_MARGIN_M = 0.15; // a contact this close to a patch (same facing) grows it instead of starting one
const FLOOR_ALIGN = 0.7; // pushed up harder than this = a floor strike, out of sight
export const METAL_DEPTH = 0.45; // through the paint from here (the shader's threshold)
const METAL_COLOR = new THREE.Color(0xb4b7bc);
const PATCH_FLOATS = 12; // centre xyz, half length, slide dir xyz, half width, outward normal xyz, depth

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const _push = new CANNON.Vec3();
const _r = new CANNON.Vec3();
const _vel = new CANNON.Vec3();
const _inverseQuat = new CANNON.Quaternion();
const _local = new CANNON.Vec3();
const _localPush = new CANNON.Vec3();
const _localSlide = new CANNON.Vec3();

/**
 * @returns {{ patches: object[], uniforms: object, noWear: boolean, contact(body: CANNON.Body, contact: object, part: number): void,
 *   addRandom(): void, polish(): void, repair(): void, deepest(): number, anchor(): number[] | null, getState(): number[][], setState(state: unknown): void }}
 */
export function createBodyScratches() {
  const data = new Float32Array(3 * MAX_PATCHES * 4);
  const texture = new THREE.DataTexture(data, 3, MAX_PATCHES, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  const uniforms = {
    scratchMap: { value: texture },
    scratchCount: { value: 0 },
    scratchMetalColor: { value: METAL_COLOR },
  };
  const patches = []; // { c: Vector3, dir: Vector3, n: Vector3, halfLength, halfWidth, depth }

  const scratches = {
    patches,
    uniforms,
    noWear: false, // editor: nothing marks the paint
    contact,
    addRandom,
    polish,
    repair,
    deepest: () => patches.reduce((d, p) => Math.max(d, p.depth), 0),
    anchor,
    getState,
    setState,
  };

  /** A collide event's contact of `body` (body part `part`) with a building or the ground. */
  function contact(body, contact, part) {
    if (scratches.noWear) return;
    const isBi = contact.bi === body;
    if (isBi) contact.ni.negate(_push);
    else _push.copy(contact.ni);
    const r = isBi ? contact.ri : contact.rj;
    body.quaternion.conjugate(_inverseQuat);
    _inverseQuat.vmult(_push, _localPush);
    if (_localPush.y > FLOOR_ALIGN) return;
    // Velocity of the contact point (the obstacle stands still), less its part along the normal.
    body.angularVelocity.cross(r, _vel);
    _vel.vadd(body.velocity, _vel);
    _push.scale(_vel.dot(_push), _r);
    _vel.vsub(_r, _vel);
    const slide = _vel.length();
    const impact = Math.abs(contact.getImpactVelocityAlongNormal());
    const severity = clamp01((impact - HIT_MIN_MS) / (HIT_FULL_MS - HIT_MIN_MS));
    if (severity <= 0 && slide < SLIDE_MIN_MS) return;
    const slidM = slide >= SLIDE_MIN_MS ? slide * Math.max(0, body.world?.dt ?? 1 / 60) : 0;
    _inverseQuat.vmult(r, _local);
    _inverseQuat.vmult(_vel, _localSlide);
    const point = new THREE.Vector3(_local.x + part * PART_OFFSET_M, _local.y, _local.z);
    const normal = new THREE.Vector3(-_localPush.x, -_localPush.y, -_localPush.z).normalize();
    const dir = slide > 1e-3 ? new THREE.Vector3(_localSlide.x, _localSlide.y, _localSlide.z).normalize() : anyTangent(normal);
    mark(point, normal, dir, severity, slidM);
  }

  function mark(point, normal, dir, severity, slidM) {
    const depthGain = slidM * SCRAPE_DEPTH_PER_M;
    let patch = patches.find((p) => p.n.dot(normal) > 0.5 && reaches(p, point));
    if (!patch) {
      if (severity <= 0 && depthGain <= 0) return;
      patch = {
        c: point.clone(),
        dir: dir.clone(),
        n: normal.clone(),
        halfLength: MIN_HALF_LENGTH_M + HIT_LENGTH_M * severity,
        halfWidth: MIN_HALF_WIDTH_M + HIT_WIDTH_M * severity,
        depth: 0,
      };
      if (patches.length >= MAX_PATCHES) patches.splice(smallestIndex(), 1);
      patches.push(patch);
    } else {
      // Stretch along the patch to take the new point in.
      const along = point.clone().sub(patch.c).dot(patch.dir);
      const lo = Math.min(-patch.halfLength, along - MIN_HALF_LENGTH_M);
      const hi = Math.max(patch.halfLength, along + MIN_HALF_LENGTH_M);
      patch.c.addScaledVector(patch.dir, (lo + hi) / 2);
      patch.halfLength = (hi - lo) / 2;
      patch.halfWidth = Math.min(MAX_HALF_WIDTH_M, Math.max(patch.halfWidth, MIN_HALF_WIDTH_M + HIT_WIDTH_M * severity));
    }
    patch.halfLength = Math.min(MAX_HALF_LENGTH_M, patch.halfLength + slidM * SCRAPE_STRETCH_PER_M);
    patch.depth = clamp01(Math.max(patch.depth, severity) + depthGain);
    upload();
  }

  function reaches(p, point) {
    const r = point.clone().sub(p.c);
    const along = Math.abs(r.dot(p.dir)) - p.halfLength;
    const across = Math.abs(r.dot(_side.crossVectors(p.n, p.dir))) - p.halfWidth;
    return along < MERGE_MARGIN_M && across < MERGE_MARGIN_M && Math.abs(r.dot(p.n)) < MERGE_MARGIN_M * 2;
  }

  function smallestIndex() {
    let best = 0;
    let bestSize = Infinity;
    patches.forEach((p, i) => {
      const size = p.depth * p.halfLength * p.halfWidth;
      if (size < bestSize) {
        bestSize = size;
        best = i;
      }
    });
    return best;
  }

  /** Debug: a random scrape somewhere on the chassis sides. */
  function addRandom() {
    const side = Math.random() < 0.5 ? 1 : -1;
    const point = new THREE.Vector3(side * 0.85, 0.5 + Math.random() * 0.4, (Math.random() - 0.5) * 3);
    mark(point, new THREE.Vector3(side, 0, 0), new THREE.Vector3(0, 0, 1), Math.random(), 4 + Math.random() * 10);
  }

  /** Polishes out the scuffs; bare metal stays. */
  function polish() {
    for (let i = patches.length - 1; i >= 0; i--) if (patches[i].depth < METAL_DEPTH) patches.splice(i, 1);
    upload();
  }

  function repair() {
    patches.length = 0;
    upload();
  }

  /** Chassis-local centre of the deepest chassis patch (app/partCallouts.js), or null. */
  function anchor() {
    let best = null;
    for (const p of patches) if (p.c.x < PART_OFFSET_M / 2 && (!best || p.depth > best.depth)) best = p;
    return best ? best.c.toArray() : null;
  }

  function upload() {
    data.fill(0);
    patches.forEach((p, i) => {
      const o = i * 12;
      data.set([p.c.x, p.c.y, p.c.z, p.halfLength, p.dir.x, p.dir.y, p.dir.z, p.halfWidth, p.n.x, p.n.y, p.n.z, p.depth], o);
    });
    uniforms.scratchCount.value = patches.length;
    texture.needsUpdate = true;
  }

  const round = (v) => Math.round(v * 1000) / 1000;
  function getState() {
    return patches.map((p) => [...p.c.toArray(), p.halfLength, ...p.dir.toArray(), p.halfWidth, ...p.n.toArray(), p.depth].map(round));
  }

  function setState(state) {
    patches.length = 0;
    if (Array.isArray(state)) {
      for (const row of state.slice(0, MAX_PATCHES)) {
        if (!Array.isArray(row) || row.length !== PATCH_FLOATS || !row.every(Number.isFinite)) continue;
        patches.push({
          c: new THREE.Vector3(row[0], row[1], row[2]),
          halfLength: row[3],
          dir: new THREE.Vector3(row[4], row[5], row[6]).normalize(),
          halfWidth: row[7],
          n: new THREE.Vector3(row[8], row[9], row[10]).normalize(),
          depth: clamp01(row[11]),
        });
      }
    }
    upload();
  }

  return scratches;
}

const _side = new THREE.Vector3();
function anyTangent(normal) {
  const t = Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  return t.addScaledVector(normal, -t.dot(normal)).normalize();
}

// After bodyDirt.js's head (uses its dirtNoise and vDirtCoord).
export const SCRATCH_FRAGMENT_HEAD = /* glsl */ `
uniform sampler2D scratchMap;
uniform int scratchCount;
uniform vec3 scratchMetalColor;
// 0 untouched .. 1 bare metal, at body point p.
float scratchDepthAt(vec3 p) {
  float deepest = 0.0;
  for (int i = 0; i < ${MAX_PATCHES}; i++) {
    if (i >= scratchCount) break;
    vec4 c = texelFetch(scratchMap, ivec2(0, i), 0);
    vec4 d = texelFetch(scratchMap, ivec2(1, i), 0);
    vec4 n = texelFetch(scratchMap, ivec2(2, i), 0);
    vec3 r = p - c.xyz;
    float along = dot(r, d.xyz);
    float across = dot(r, cross(n.xyz, d.xyz));
    float off = dot(r, n.xyz);
    float e = along * along / (c.w * c.w) + across * across / (d.w * d.w) + off * off / 0.16;
    if (e >= 1.0) continue;
    float seed = float(i) * 7.31;
    // Streaks: narrow across the slide, long along it.
    float streak = max(dirtNoise(vec3(across * 40.0, along * 2.0, seed)), 0.9 * dirtNoise(vec3(across * 100.0, along * 4.0, seed + 11.0)));
    float depth = n.w * (0.45 + 0.55 * (1.0 - e)) * (0.7 + 0.5 * streak);
    float cover = smoothstep(1.0 - 0.8 * n.w - 0.1, 1.0 - 0.8 * n.w, streak * (1.0 - 0.6 * e));
    deepest = max(deepest, cover * depth);
  }
  return deepest;
}`;

// Before the dirt's colour, so dirt covers the scratches.
export const SCRATCH_COLOR_FRAGMENT = /* glsl */ `
float scratchDepth = scratchCount > 0 ? scratchDepthAt(vDirtCoord.xyz) : 0.0;
float scratchScuff = smoothstep(0.0, 0.03, scratchDepth);
float scratchMetal = smoothstep(${METAL_DEPTH.toFixed(2)}, ${(METAL_DEPTH + 0.05).toFixed(2)}, scratchDepth);
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.6 + 0.3, scratchScuff * 0.6);
diffuseColor.rgb = mix(diffuseColor.rgb, scratchMetalColor, scratchMetal);`;

export const SCRATCH_ROUGHNESS_FRAGMENT = /* glsl */ `
roughnessFactor = mix(roughnessFactor, 0.6, scratchScuff);
roughnessFactor = mix(roughnessFactor, 0.3, scratchMetal);`;

export const SCRATCH_METALNESS_FRAGMENT = /* glsl */ `
metalnessFactor = mix(metalnessFactor, 1.0, scratchMetal);`;

export const SCRATCH_CLEARCOAT_FRAGMENT = /* glsl */ `
material.clearcoat *= 1.0 - scratchScuff;`;
