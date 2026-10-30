// Fireworks over a split flag when it's passed: a few rockets climb, then burst into
// coloured sparks that fall and fade. One Points cloud, preallocated; visual only.

import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, PointsMaterial } from 'three';
import { keepParticle } from '../particles/particleDetail.js';

const MAX_PARTICLES = 1500;
const ROCKETS = 4;
const SPARKS_PER_BURST = 90;
const ROCKET_SPEED = 26; // m/s up
const ROCKET_FUSE_S = [0.7, 1.1];
const SPARK_SPEED = [6, 13];
const SPARK_LIFE_S = [1.1, 1.8];
const GRAVITY = -6; // sparks drift down slowly, like real ones
const DRAG = 0.9; // velocity kept per second
const COLORS = [
  [1, 0.25, 0.2],
  [1, 0.85, 0.2],
  [0.3, 0.6, 1],
  [0.4, 1, 0.4],
  [1, 0.4, 1],
  [1, 1, 1],
];

const rand = ([a, b]) => a + Math.random() * (b - a);

export function createFireworks(scene) {
  const positions = new Float32Array(MAX_PARTICLES * 3);
  const colors = new Float32Array(MAX_PARTICLES * 3);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const points = new Points(
    geometry,
    new PointsMaterial({ size: 0.6, vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending })
  );
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);

  // { x, y, z, vx, vy, vz, life, maxLife, color, rocket, fuse }
  const particles = [];
  const pending = []; // { at, x, y, z } delayed launches

  function launch(x, y, z) {
    if (particles.length >= MAX_PARTICLES) return;
    particles.push({
      x: x + (Math.random() - 0.5) * 4,
      y,
      z: z + (Math.random() - 0.5) * 4,
      vx: (Math.random() - 0.5) * 3,
      vy: ROCKET_SPEED * rand([0.8, 1.1]),
      vz: (Math.random() - 0.5) * 3,
      life: 0,
      maxLife: rand(ROCKET_FUSE_S),
      color: [1, 0.8, 0.5],
      rocket: true,
    });
  }

  function burst(p) {
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    for (let i = 0; i < SPARKS_PER_BURST && particles.length < MAX_PARTICLES; i++) {
      if (!keepParticle()) continue;
      // Uniform direction on a sphere.
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const speed = rand(SPARK_SPEED);
      particles.push({
        x: p.x,
        y: p.y,
        z: p.z,
        vx: r * Math.cos(a) * speed,
        vy: u * speed,
        vz: r * Math.sin(a) * speed,
        life: 0,
        maxLife: rand(SPARK_LIFE_S),
        color,
        rocket: false,
      });
    }
  }

  let time = 0;

  return {
    /** A volley of rockets from ground point (x, y, z). */
    fire(x, y, z) {
      for (let i = 0; i < ROCKETS; i++) pending.push({ at: time + i * 0.25, x, y, z });
    },
    update(dt) {
      time += dt;
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].at > time) continue;
        launch(pending[i].x, pending[i].y, pending[i].z);
        pending.splice(i, 1);
      }
      const drag = DRAG ** dt;
      let n = 0;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += dt;
        if (p.life >= p.maxLife) {
          if (p.rocket) burst(p);
          particles[i] = particles[particles.length - 1];
          particles.pop();
          continue;
        }
        if (!p.rocket) {
          p.vx *= drag;
          p.vy = p.vy * drag + GRAVITY * dt;
          p.vz *= drag;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
      }
      for (const p of particles) {
        const fade = p.rocket ? 1 : 1 - p.life / p.maxLife;
        positions.set([p.x, p.y, p.z], n * 3);
        colors.set([p.color[0] * fade, p.color[1] * fade, p.color[2] * fade], n * 3);
        n++;
      }
      geometry.setDrawRange(0, n);
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.color.needsUpdate = true;
      points.visible = n > 0;
    },
    shiftOrigin(dx, dz) {
      // Particles are world positions; undo the scene-wide shift of the cloud itself.
      points.position.set(0, 0, 0);
      for (const p of particles) {
        p.x -= dx;
        p.z -= dz;
      }
      for (const p of pending) {
        p.x -= dx;
        p.z -= dz;
      }
    },
  };
}
