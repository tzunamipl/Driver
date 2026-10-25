// Sparkles: glowing streaks shot up and out from a point (a rally control's pole,
// a rim on tarmac), stretched along their flight and fading as they fall.
// One InstancedMesh; visual only.

import { AdditiveBlending, BoxGeometry, Color, InstancedMesh, MeshBasicMaterial, Object3D } from 'three';

const MAX_SPARKS = 800;
const SPARKS_PER_THROW = 40;
const STREAK_WIDTH_M = 0.03;
const STREAK_S = 0.05; // a streak is as long as its flight over this much time
const MIN_STREAK_M = 0.08;
const LAUNCH_SPEED = [5, 10]; // m/s
const LIFE_S = [0.7, 1.3];
const UP = [0.4, 1]; // vertical share of the launch direction
const GRAVITY = -9.81;
const DRAG = 1.2; // 1/s
const COLORS = [0xfff2b0, 0xffd34d, 0xffffff, 0xffe08a].map((c) => new Color(c));
const COOLED = new Color(0xff6a10);
const COOL_SHARE = 0.25; // share of its life a spark takes to cool from its hot colour to orange

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
  // { x, y, z, vx, vy, vz, life, maxLife, size, color }
  const sparks = [];

  return {
    /**
     * One throw of sparks from world point (x, y, z), e.g. a pole's top.
     * Options override count, speed / up / life ranges; `inherit` = velocity added to every spark,
     * `size` = streak scale, `spread` = radius (m) of the random start offset around the point.
     */
    throw(
      x,
      y,
      z,
      { count = SPARKS_PER_THROW, speed: speedRange = LAUNCH_SPEED, up: upRange = UP, life = LIFE_S, inherit, size = 1, spread = 0 } = {}
    ) {
      for (let i = 0; i < count && sparks.length < MAX_SPARKS; i++) {
        const offA = Math.random() * Math.PI * 2;
        const offR = spread * Math.sqrt(Math.random());
        const a = Math.random() * Math.PI * 2;
        const up = rand(upRange);
        const speed = rand(speedRange);
        const side = Math.sqrt(1 - up * up) * speed;
        sparks.push({
          x: x + Math.cos(offA) * offR,
          y,
          z: z + Math.sin(offA) * offR,
          vx: Math.cos(a) * side + (inherit?.x ?? 0),
          vy: up * speed + (inherit?.y ?? 0),
          vz: Math.sin(a) * side + (inherit?.z ?? 0),
          life: 0,
          maxLife: rand(life),
          size,
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
        const streakS = STREAK_S * s.size;
        dummy.position.set(s.x - (s.vx * streakS) / 2, s.y - (s.vy * streakS) / 2, s.z - (s.vz * streakS) / 2);
        dummy.lookAt(s.x, s.y, s.z);
        dummy.scale.set(s.size, s.size, Math.max(MIN_STREAK_M * s.size, speed * streakS));
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        // Cools to orange early, then fades out (additive: fading to black).
        const age = s.life / s.maxLife;
        mesh.setColorAt(i, color.copy(s.color).lerp(COOLED, Math.min(1, age / COOL_SHARE)).multiplyScalar(1 - age));
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
