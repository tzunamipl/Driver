// Droplets flung off a rolling tyre on a wet surface: thrown back off the tread and
// up, more with speed, tyre wetness (weather floor, or still dripping after wading)
// and how much water the surface holds (SURFACE_SPRAY). One InstancedMesh; visual only.

import { Color, IcosahedronGeometry, InstancedMesh, MeshStandardMaterial, Object3D } from 'three';
import { keepParticle } from './particles/particleDetail.js';
import { isWheelGrounded } from './wheelContact.js';
import { getWetness } from './weather.js';

const MAX_DROPS = 600;

// Droplets per metre rolled on a soaked tyre; surfaces left out don't spray (water splashes in splash.js).
const SURFACE_SPRAY = {
  road: 1.6,
  cobblestone: 1.4,
  builtUp: 1.3,
  rock: 0.8,
  unpaved: 0.6,
  mud: 0.5,
  snow: 0.7,
  normal: 0.25,
  scrub: 0.25,
  forest: 0.15,
};

const MIN_SPEED = 2.5; // m/s
const MIN_WETNESS = 0.05;
const MAX_PER_S = 70; // per wheel
const BACK_FRACTION = [0.15, 0.45]; // share of the rolling speed a drop leaves backwards with
const MAX_BACK_SPEED = 9;
const UP_SPEED = [0.8, 2.6]; // m/s, x sqrt(speed / 10)
const SPREAD = 1.2; // m/s random sideways scatter
const DRAG = 1.8; // 1/s: fine drops slow fast
const GRAVITY = -9.81;
const LIFE = [0.35, 0.7];
const SIZE = [0.012, 0.03];
const STRETCH = 0.006; // extra streak length (m) per m/s of flight speed
const COLORS = [0xd8e2e8, 0xc4d0d8, 0xeef3f6];

const rand = ([a, b]) => a + Math.random() * (b - a);

export function createWetSpray(scene) {
  const mesh = new InstancedMesh(
    new IcosahedronGeometry(0.5, 0),
    new MeshStandardMaterial({ roughness: 0.15, metalness: 0, transparent: true, opacity: 0.6, depthWrite: false }),
    MAX_DROPS
  );
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.castShadow = false;
  scene.add(mesh);
  const drops = [];
  const dummy = new Object3D();
  const color = new Color();
  const owed = new Map(); // wheel -> fractional drops carried to the next frame
  let enabled = true;

  function emit(dt, vehicle, world) {
    const velocity = vehicle.chassisBody.velocity;
    for (const wheel of vehicle.wheelInfos) {
      const perM = SURFACE_SPRAY[wheel.surface];
      const wetness = wheel.wetness ?? getWetness();
      const f = wheel.forwardWorld;
      // Tread surface speed over the ground, wheelspin included.
      const rolling = velocity.x * f.x + velocity.z * f.z + (wheel.spinSlipSpeed ?? 0);
      const speed = Math.abs(rolling);
      if (!perM || wetness < MIN_WETNESS || speed < MIN_SPEED || !isWheelGrounded(world, wheel)) {
        owed.delete(wheel);
        continue;
      }
      const n = (owed.get(wheel) ?? 0) + Math.min(speed * perM * wetness, MAX_PER_S) * dt;
      const count = Math.floor(n);
      owed.set(wheel, n - count);
      if (count === 0) continue;

      const pos = wheel.worldTransform.position;
      const floorY = pos.y - wheel.radius;
      // Thrown opposite to the tread's travel over the ground.
      const sign = rolling > 0 ? -1 : 1;
      const dirX = f.x * sign;
      const dirZ = f.z * sign;
      const upScale = Math.sqrt(Math.min(speed, 30) / 10);
      for (let i = 0; i < count && drops.length < MAX_DROPS; i++) {
        if (!keepParticle()) continue;
        const back = Math.min(speed * rand(BACK_FRACTION), MAX_BACK_SPEED);
        // Off the trailing half of the tyre, low on the tread.
        const behind = wheel.radius * rand([0.4, 0.9]);
        drops.push({
          x: pos.x + dirX * behind + (Math.random() - 0.5) * 0.15,
          y: floorY + rand([0.03, 0.2]),
          z: pos.z + dirZ * behind + (Math.random() - 0.5) * 0.15,
          // Keep part of the car's own motion: drops trail just behind the wheel.
          vx: velocity.x * 0.6 + dirX * back + (Math.random() - 0.5) * 2 * SPREAD,
          vy: rand(UP_SPEED) * upScale,
          vz: velocity.z * 0.6 + dirZ * back + (Math.random() - 0.5) * 2 * SPREAD,
          floorY,
          size: rand(SIZE),
          life: 0,
          maxLife: rand(LIFE),
          color: COLORS[Math.floor(Math.random() * COLORS.length)],
        });
      }
    }
  }

  function step(dt) {
    const drag = Math.exp(-DRAG * dt);
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.life += dt;
      d.vx *= drag;
      d.vz *= drag;
      d.vy = d.vy * drag + GRAVITY * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      // Water doesn't bounce: gone on landing.
      if (d.life >= d.maxLife || (d.y <= d.floorY && d.vy < 0)) {
        drops[i] = drops[drops.length - 1];
        drops.pop();
      }
    }
    drops.forEach((d, i) => {
      const fade = Math.min(1, (d.maxLife - d.life) / (d.maxLife * 0.4));
      const v = Math.hypot(d.vx, d.vy, d.vz);
      dummy.position.set(d.x, d.y, d.z);
      // Stretched along its flight: a streak rather than a ball.
      dummy.lookAt(d.x + d.vx, d.y + d.vy, d.z + d.vz);
      dummy.scale.set(d.size * fade, d.size * fade, (d.size + v * STRETCH) * fade);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, color.setHex(d.color));
    });
    mesh.count = drops.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  return {
    /** Call once per rendered frame; `vehicle` / `world` may be null before a car exists. */
    update(dt, vehicle, world) {
      if (enabled && vehicle && world) emit(dt, vehicle, world);
      step(dt);
    },

    /** Off: no new drops (drops in flight finish). */
    setEnabled(on) {
      enabled = on;
      if (!on) owed.clear();
    },

    shiftOrigin(dx, dz) {
      // Drops are world positions; undo the scene-wide shift of the mesh itself.
      mesh.position.set(0, 0, 0);
      for (const d of drops) {
        d.x -= dx;
        d.z -= dz;
      }
    },
  };
}
