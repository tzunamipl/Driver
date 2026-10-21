// Debug effect: meshes streamed out during a teleport burst into blue rectangles that
// drift up, spin and shrink away. One instanced mesh for every particle; visual only.

import * as THREE from 'three';

const CAPACITY = 6000;
const LIFETIME_S = [1.2, 2.2];
const DELAY_S = 0.35; // spawn spread, so a tile streams away instead of popping
const RISE = [1.5, 4]; // particle sizes per second
const SPREAD = 0.8; // horizontal drift, particle sizes per second
const SPIN = 4; // rad/s, max per axis
const COLORS = [0x1e6bff, 0x4fa8ff, 0x8fd6ff];
const MESH_PARTICLES = 220;
const MESH_SIZE_FRACTION = 0.05; // of the bounding radius
const MIN_SIZE_M = 0.25;
const MAX_SIZE_M = 40;
const LINGER_S = 2; // after a teleport, for the tiles still being swapped

const randIn = (min, max) => min + Math.random() * (max - min);

/** @param {THREE.Scene} scene */
export function createDissolve(scene) {
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.6, 0.08), material, CAPACITY);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  const color = new THREE.Color();
  for (let i = 0; i < CAPACITY; i++) mesh.setColorAt(i, color.setHex(COLORS[i % COLORS.length]));
  scene.add(mesh);

  // Live particles, packed in [0, live); positions are mesh-local (the mesh follows floating-origin shifts).
  const particles = Array.from({ length: CAPACITY }, () => ({
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    rot: new THREE.Euler(),
    spin: new THREE.Vector3(),
    size: 1,
    delay: 0,
    age: 0,
    life: 1,
  }));
  let live = 0;
  let enabled = false;
  let isActive = () => true;
  let linger = 0;
  const spawning = () => enabled && (linger > 0 || isActive());

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const point = new THREE.Vector3();

  function spawnAt(x, y, z, size) {
    if (live === CAPACITY) return;
    const p = particles[live++];
    p.pos.set(x - mesh.position.x, y - mesh.position.y, z - mesh.position.z);
    const angle = Math.random() * Math.PI * 2;
    const out = randIn(0, SPREAD) * size;
    p.vel.set(Math.cos(angle) * out, randIn(RISE[0], RISE[1]) * size, Math.sin(angle) * out);
    p.rot.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
    p.spin.set(randIn(-SPIN, SPIN), randIn(-SPIN, SPIN), randIn(-SPIN, SPIN));
    p.size = size * randIn(0.6, 1.2);
    p.delay = Math.random() * DELAY_S;
    p.age = 0;
    p.life = randIn(LIFETIME_S[0], LIFETIME_S[1]);
  }

  return {
    setEnabled(value) {
      enabled = value;
      if (!value) live = mesh.count = 0;
    },

    /** `fn() -> bool`: only bursts while it's true (and LINGER_S after). */
    setActiveWhen(fn) {
      isActive = fn;
    },

    /** Bursts `object3d`'s geometry (sampled vertices, world space) into particles. */
    dissolveMesh(object3d, count = MESH_PARTICLES) {
      const position = object3d?.geometry?.attributes.position;
      if (!spawning() || !position?.count) return;
      const geometry = object3d.geometry;
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      const size = THREE.MathUtils.clamp(geometry.boundingSphere.radius * MESH_SIZE_FRACTION, MIN_SIZE_M, MAX_SIZE_M);
      object3d.updateWorldMatrix(true, false);
      for (let i = 0; i < count; i++) {
        point.fromBufferAttribute(position, Math.floor(Math.random() * position.count)).applyMatrix4(object3d.matrixWorld);
        spawnAt(point.x, point.y, point.z, size);
      }
    },

    /** Bursts a column (e.g. a tree) of `height` metres standing at x, y, z. */
    dissolveColumn(x, y, z, height, count = 24) {
      if (!spawning()) return;
      const size = THREE.MathUtils.clamp(height * 0.12, MIN_SIZE_M, MAX_SIZE_M);
      const radius = height * 0.25;
      for (let i = 0; i < count; i++) {
        spawnAt(x + randIn(-radius, radius), y + Math.random() * height, z + randIn(-radius, radius), size);
      }
    },

    /** Call once per frame. */
    update(dt) {
      linger = isActive() ? LINGER_S : Math.max(0, linger - dt);
      if (!live) return;
      for (let i = 0; i < live; ) {
        const p = particles[i];
        p.age += dt;
        if (p.age >= p.delay + p.life) {
          particles[i] = particles[--live];
          particles[live] = p;
          continue;
        }
        if (p.age > p.delay) {
          p.pos.addScaledVector(p.vel, dt);
          p.rot.x += p.spin.x * dt;
          p.rot.y += p.spin.y * dt;
          p.rot.z += p.spin.z * dt;
        }
        const t = Math.max(0, p.age - p.delay) / p.life;
        // Pops in over the first few % of its life, then shrinks to nothing.
        const s = p.size * Math.min(1, t * 12) * (1 - t);
        matrix.compose(p.pos, quaternion.setFromEuler(p.rot), scale.setScalar(s));
        mesh.setMatrixAt(i, matrix);
        i++;
      }
      mesh.count = live;
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
