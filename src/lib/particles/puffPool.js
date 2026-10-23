// Pooled smoke/dust puffs: spheres reused round-robin that drift with drag,
// grow from startScale to their endScale and fade out over their lifetime.
// Each particle owns its material so it can fade independently.

import * as THREE from 'three';

const PUFF_GEO = new THREE.SphereGeometry(1, 6, 5);
// Puffs are unlit, so the day-night cycle tints them at spawn instead (white = daylight).
const tint = new THREE.Color(1, 1, 1);

/** Sets the light colour multiplied into newly spawned puffs. */
export function setPuffTint(color) {
  tint.copy(color);
}

const randIn = ([min, max]) => min + Math.random() * (max - min);
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * @param {THREE.Scene} scene
 * @param {{size: number, lifetime: number, startScale: number, drag: number, colors: [number, number], glow?: boolean}} opts
 *   drag multiplies velocity each second; colors are picked 50/50 per puff;
 *   glow = additive and untinted (self-lit, e.g. flames).
 */
export function createPuffPool(scene, { size, lifetime, startScale, drag, colors, glow = false }) {
  const pool = [];
  const blending = glow ? THREE.AdditiveBlending : THREE.NormalBlending;
  for (let i = 0; i < size; i++) {
    const material = new THREE.MeshBasicMaterial({ color: colors[0], transparent: true, opacity: 0, depthWrite: false, blending });
    const mesh = new THREE.Mesh(PUFF_GEO, material);
    mesh.visible = false;
    scene.add(mesh);
    pool.push({ mesh, material, velocity: new THREE.Vector3(), life: 0, opacity: 0, endScale: startScale });
  }
  let nextSlot = 0;

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
    const p = pool[nextSlot];
    nextSlot = (nextSlot + 1) % size;
    p.life = lifetime;
    p.opacity = opacity;
    p.endScale = endScale;
    p.mesh.visible = true;
    p.mesh.scale.setScalar(startScale);
    p.mesh.position.set(x, y, z);
    p.material.color.setHex(puffColors[Math.random() < 0.5 ? 0 : 1]);
    if (!glow) p.material.color.multiply(tint);
    p.material.opacity = opacity;
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
    for (const p of pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.visible = false;
        continue;
      }
      p.velocity.multiplyScalar(dragFactor);
      p.mesh.position.addScaledVector(p.velocity, dt);
      const t = 1 - p.life / lifetime;
      p.mesh.scale.setScalar(startScale + (p.endScale - startScale) * t);
      p.material.opacity = p.opacity * (1 - t);
    }
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
