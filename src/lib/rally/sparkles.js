// Sparkles thrown at a passed control: glowing streaks shot up and out from a pole,
// stretched along their flight and fading as they fall. One InstancedMesh; visual only.

import { AdditiveBlending, BoxGeometry, Color, InstancedMesh, MeshBasicMaterial, Object3D } from 'three';

const MAX_SPARKS = 800;
const SPARKS_PER_THROW = 40;
const STREAK_WIDTH_M = 0.03;
const STREAK_S = 0.05; // a streak is as long as its flight over this much time
const MIN_STREAK_M = 0.08;
const LAUNCH_SPEED = [5, 10]; // m/s
const LIFE_S = [0.7, 1.3];
const GRAVITY = -9.81;
const DRAG = 1.2; // 1/s
const COLORS = [0xfff2b0, 0xffd34d, 0xffffff, 0xffb347].map((c) => new Color(c));

const rand = ([a, b]) => a + Math.random() * (b - a);

export function createSparkles(scene) {
  // Unit-long box along +z, scaled per spark to its streak length.
  const geometry = new BoxGeometry(STREAK_WIDTH_M, STREAK_WIDTH_M, 1);
  const mesh = new InstancedMesh(
    geometry,
    new MeshBasicMaterial({ blending: AdditiveBlending, transparent: true, depthWrite: false }),
    MAX_SPARKS
  );
  mesh.frustumCulled = false;
  mesh.count = 0;
  scene.add(mesh);
  const dummy = new Object3D();
  const color = new Color();
  // { x, y, z, vx, vy, vz, life, maxLife, color }
  const sparks = [];

  return {
    /** One throw of sparks from world point (x, y, z), e.g. a pole's top. */
    throw(x, y, z) {
      for (let i = 0; i < SPARKS_PER_THROW && sparks.length < MAX_SPARKS; i++) {
        const a = Math.random() * Math.PI * 2;
        const up = 0.4 + Math.random() * 0.6; // mostly upwards
        const speed = rand(LAUNCH_SPEED);
        const side = Math.sqrt(1 - up * up) * speed;
        sparks.push({
          x,
          y,
          z,
          vx: Math.cos(a) * side,
          vy: up * speed,
          vz: Math.sin(a) * side,
          life: 0,
          maxLife: rand(LIFE_S),
          color: COLORS[Math.floor(Math.random() * COLORS.length)],
        });
      }
    },

    update(dt) {
      const drag = Math.exp(-DRAG * dt);
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.life += dt;
        if (s.life >= s.maxLife) {
          sparks[i] = sparks[sparks.length - 1];
          sparks.pop();
          continue;
        }
        s.vx *= drag;
        s.vz *= drag;
        s.vy = s.vy * drag + GRAVITY * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.z += s.vz * dt;
      }
      sparks.forEach((s, i) => {
        const speed = Math.hypot(s.vx, s.vy, s.vz);
        // Streak trails behind the spark, pointing along its flight.
        dummy.position.set(s.x - (s.vx * STREAK_S) / 2, s.y - (s.vy * STREAK_S) / 2, s.z - (s.vz * STREAK_S) / 2);
        dummy.lookAt(s.x, s.y, s.z);
        dummy.scale.set(1, 1, Math.max(MIN_STREAK_M, speed * STREAK_S));
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        // Additive: fading to black fades out.
        mesh.setColorAt(i, color.copy(s.color).multiplyScalar(1 - s.life / s.maxLife));
      });
      mesh.count = sparks.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },

    shiftOrigin(dx, dz) {
      // Sparks are world positions; undo the scene-wide shift of the mesh itself.
      mesh.position.set(0, 0, 0);
      for (const s of sparks) {
        s.x -= dx;
        s.z -= dz;
      }
    },
  };
}
