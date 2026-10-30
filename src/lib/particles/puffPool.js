// Pooled smoke/dust puffs: spheres reused round-robin that drift with drag,
// grow from startScale to their endScale and fade out over their lifetime.
// One InstancedMesh per pool (one draw call); live puffs are packed to the front each frame,
// with per-instance colour and opacity.

import * as THREE from 'three';
import { keepParticle } from './particleDetail.js';

const PUFF_GEO = new THREE.SphereGeometry(1, 6, 5);
// Puffs are unlit, so the day-night cycle tints them at spawn instead (white = daylight).
const tint = new THREE.Color(1, 1, 1);

/** Sets the light colour multiplied into newly spawned puffs. */
export function setPuffTint(color) {
  tint.copy(color);
}

const randIn = ([min, max]) => min + Math.random() * (max - min);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** Basic material reading alpha from the `instanceOpacity` attribute. */
function createPuffMaterial(blending) {
  const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'attribute float instanceOpacity;\nvarying float vOpacity;\nvoid main() {\n  vOpacity = instanceOpacity;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'varying float vOpacity;\nvoid main() {')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse, opacity * vOpacity );');
  };
  return material;
}

/**
 * @param {THREE.Scene} scene
 * @param {{size: number, lifetime: number, startScale: number, drag: number, colors: [number, number], glow?: boolean, buoyancy?: number}} opts
 *   drag multiplies velocity each second; colors are picked 50/50 per puff;
 *   glow = additive and untinted (self-lit, e.g. flames);
 *   buoyancy = steady upward acceleration (m/s²), so puffs keep drifting up after drag.
 */
export function createPuffPool(scene, { size, lifetime, startScale, drag, colors, glow = false, buoyancy = 0 }) {
  const geometry = PUFF_GEO.clone(); // the opacity attribute is per pool
  const opacities = new THREE.InstancedBufferAttribute(new Float32Array(size), 1);
  opacities.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('instanceOpacity', opacities);
  const mesh = new THREE.InstancedMesh(geometry, createPuffMaterial(glow ? THREE.AdditiveBlending : THREE.NormalBlending), size);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, tint); // allocates instanceColor
  mesh.frustumCulled = false; // instances drift anywhere around the car
  mesh.count = 0;
  scene.add(mesh);

  // Puff positions are relative to the mesh, so the floating origin's shift of it carries them.
  const pool = [];
  for (let i = 0; i < size; i++) {
    pool.push({ position: new THREE.Vector3(), velocity: new THREE.Vector3(), color: new THREE.Color(), life: 0, opacity: 0, endScale: startScale });
  }
  let nextSlot = 0;
  const dummy = new THREE.Object3D();

  /**
   * Spawns one puff, overwriting the oldest slot.
   * @param {object} o
   * @param {number} o.opacity - starting opacity, fades to 0.
   * @param {number} o.endScale
   * @param {[number, number]} o.out - horizontal speed range, random direction.
   * @param {[number, number]} o.rise - upward speed range.
   * @param {{x: number, z: number}} [o.inherit] - velocity partially inherited (x/z only).
   * @param {number} [o.inheritFraction]
   * @param {{x: number, z: number}} [o.extra] - velocity added as-is (x/z only).
   * @param {[number, number]} [o.colors] - overrides the pool's colours for this puff.
   */
  function spawn(x, y, z, { opacity, endScale, out, rise, inherit, inheritFraction = 0, extra, colors: puffColors = colors }) {
    if (!keepParticle()) return;
    const p = pool[nextSlot];
    nextSlot = (nextSlot + 1) % size;
    p.life = lifetime;
    p.opacity = opacity;
    p.endScale = endScale;
    p.position.set(x - mesh.position.x, y - mesh.position.y, z - mesh.position.z);
    p.color.setHex(puffColors[Math.random() < 0.5 ? 0 : 1]);
    if (!glow) p.color.multiply(tint);
    const angle = Math.random() * Math.PI * 2;
    const h = randIn(out);
    p.velocity.set(Math.cos(angle) * h, randIn(rise), Math.sin(angle) * h);
    if (inherit) {
      p.velocity.x += inherit.x * inheritFraction;
      p.velocity.z += inherit.z * inheritFraction;
    }
    if (extra) {
      p.velocity.x += extra.x;
      p.velocity.z += extra.z;
    }
  }

  /** Ages, moves, grows and fades every live puff. Call once per frame. */
  function update(dt) {
    const dragFactor = Math.pow(drag, dt);
    let n = 0;
    for (const p of pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;
      p.velocity.multiplyScalar(dragFactor);
      p.velocity.y += buoyancy * dt;
      p.position.addScaledVector(p.velocity, dt);
      const t = 1 - p.life / lifetime;
      dummy.position.copy(p.position);
      dummy.scale.setScalar(startScale + (p.endScale - startScale) * t);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
      mesh.setColorAt(n, p.color);
      opacities.array[n] = p.opacity * (1 - t);
      n++;
    }
    if (n === 0 && mesh.count === 0) return;
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    opacities.needsUpdate = true;
  }

  return { spawn, update };
}

/**
 * Launch velocity from a sliding wheel's signed spin-slip speed along its
 * forward axis (negative = overspinning, so the puff is thrown backwards).
 * Writes into and returns `out`.
 */
export function wheelSpinLaunch(wheel, fraction, maxSpeed, out) {
  const s = clamp(wheel.spinSlipSpeed * fraction, -maxSpeed, maxSpeed);
  out.x = wheel.forwardWorld.x * s;
  out.z = wheel.forwardWorld.z * s;
  return out;
}

export { clamp };
