// Debris flung by a sliding tyre on soft ground (SURFACE_DEBRIS): leaves and
// grass bits that flutter down, clods and stones that arc out and bounce once.
// Thrown along the patch's slip over the ground (wheelspin = backwards), more
// with slip speed. Two InstancedMeshes (flat bits, chunks); visual only.

import { Color, DoubleSide, IcosahedronGeometry, InstancedMesh, MeshStandardMaterial, Object3D, PlaneGeometry } from 'three';
import { isWheelGrounded } from './wheelContact.js';

const MAX_LEAVES = 500;
const MAX_CHUNKS = 500;

const GRASS = [0x4f7a2a, 0x6b8f34, 0x3d5f22];
const LEAVES = [0x6b7f2a, 0x9a7a2c, 0x7a4a1e, 0x4f6a24];
const SCRUB = [0x6a7a3a, 0x8a7a4a, 0x55602e];
const SOIL = [0x5c3f23, 0x4a321c, 0x6b4a2b];
const DARK_SOIL = [0x3d2a18, 0x4a321c, 0x2e2014];
const GRAVEL = [0x8a8378, 0x6f6a62, 0xa59d90];
const STONE = [0x8d8a84, 0x6e6b66, 0xa8a49c];
const SAND = [0xc2a66b, 0xb09460];

// perM = bits per metre of patch slip; leaf = share that are flat bits; size = chunk size range (m).
const SURFACE_DEBRIS = {
  normal: { perM: 1.2, leaf: 0.65, leafColors: GRASS, chunkColors: SOIL, size: [0.03, 0.07] },
  forest: { perM: 1.4, leaf: 0.8, leafColors: LEAVES, chunkColors: DARK_SOIL, size: [0.03, 0.07] },
  scrub: { perM: 1, leaf: 0.55, leafColors: SCRUB, chunkColors: SOIL, size: [0.03, 0.06] },
  unpaved: { perM: 3, leaf: 0, chunkColors: GRAVEL, size: [0.015, 0.045] },
  rock: { perM: 0.8, leaf: 0, chunkColors: STONE, size: [0.02, 0.06] },
  sand: { perM: 0.6, leaf: 0, chunkColors: SAND, size: [0.02, 0.05] },
};

const MIN_SLIP_SPEED = 2; // m/s
const MAX_PER_S = 35; // per wheel
const THROW_FRACTION = [0.35, 0.8]; // share of the patch slip velocity a bit leaves with
const MAX_THROW_SPEED = 12;
const SPREAD = 1.5; // m/s random sideways scatter
const UP_SPEED = [1, 3.5]; // m/s, x sqrt(slip / 5)
const GRAVITY = -9.81;

const LEAF_SIZE = [0.03, 0.07];
const LEAF_DRAG = 3.5; // 1/s: drifts down at ~3 m/s
const LEAF_FLUTTER = 1.2; // m/s sideways sway amplitude
const LEAF_LIFE = [1.6, 2.6];
const CHUNK_DRAG = 0.4;
const CHUNK_LIFE = [1.2, 2];
const CHUNK_BOUNCE = 0.3;
const SPIN = 14; // rad/s max tumble
const SHRINK_S = 0.3; // shrink away over the last part of life

const rand = ([a, b]) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function createLayer(scene, geometry, max, side) {
  const mesh = new InstancedMesh(geometry, new MeshStandardMaterial({ roughness: 1, flatShading: true, side }), max);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.castShadow = false;
  scene.add(mesh);
  return { mesh, max, bits: [] };
}

export function createWheelDebris(scene) {
  const leaves = createLayer(scene, new PlaneGeometry(1, 1), MAX_LEAVES, DoubleSide);
  const chunks = createLayer(scene, new IcosahedronGeometry(0.5, 0), MAX_CHUNKS);
  const dummy = new Object3D();
  const color = new Color();
  const owed = new Map(); // wheel -> fractional bits carried to the next frame
  let enabled = true;

  function spawn(layer, x, y, z, vx, vy, vz, floorY, d, isLeaf) {
    if (layer.bits.length >= layer.max) return;
    const size = isLeaf ? rand(LEAF_SIZE) : rand(d.size);
    layer.bits.push({
      x, y, z, vx, vy, vz, floorY,
      rx: Math.random() * 6.28, ry: Math.random() * 6.28, rz: Math.random() * 6.28,
      wx: (Math.random() - 0.5) * 2 * SPIN, wy: (Math.random() - 0.5) * 2 * SPIN, wz: (Math.random() - 0.5) * 2 * SPIN,
      // Leaves: grass blades are long and thin; chunks: lumpy.
      sx: size, sy: isLeaf ? size * (d.leafColors === GRASS ? 0.3 : 0.8) : size * rand([0.6, 1]), sz: size * rand([0.7, 1]),
      phase: Math.random() * 6.28,
      life: 0,
      maxLife: rand(isLeaf ? LEAF_LIFE : CHUNK_LIFE),
      landed: false,
      color: pick(isLeaf ? d.leafColors : d.chunkColors),
    });
  }

  function emit(dt, vehicle, world) {
    const velocity = vehicle.chassisBody.velocity;
    for (const wheel of vehicle.wheelInfos) {
      const d = SURFACE_DEBRIS[wheel.surface];
      if (!d || !wheel.sliding) {
        owed.delete(wheel);
        continue;
      }
      const f = wheel.forwardWorld;
      // Patch slip over the ground: spin slip along the tyre + the car's sideways drift.
      const along = velocity.x * f.x + velocity.z * f.z;
      const latX = velocity.x - f.x * along;
      const latZ = velocity.z - f.z * along;
      const slipX = f.x * wheel.spinSlipSpeed + latX;
      const slipZ = f.z * wheel.spinSlipSpeed + latZ;
      const slip = Math.hypot(slipX, slipZ);
      if (slip < MIN_SLIP_SPEED || !isWheelGrounded(world, wheel)) {
        owed.delete(wheel);
        continue;
      }
      const n = (owed.get(wheel) ?? 0) + Math.min(slip * d.perM, MAX_PER_S) * dt;
      const count = Math.floor(n);
      owed.set(wheel, n - count);
      if (count === 0) continue;

      const pos = wheel.worldTransform.position;
      const floorY = pos.y - wheel.radius;
      const dirX = slipX / slip;
      const dirZ = slipZ / slip;
      const upScale = Math.sqrt(Math.min(slip, 20) / 5);
      for (let i = 0; i < count; i++) {
        const throwSpeed = Math.min(slip * rand(THROW_FRACTION), MAX_THROW_SPEED);
        const isLeaf = Math.random() < d.leaf;
        // Out from the trailing edge of the patch, in the throw direction.
        const back = wheel.radius * rand([0.3, 0.7]);
        spawn(
          isLeaf ? leaves : chunks,
          pos.x + dirX * back,
          floorY + 0.05,
          pos.z + dirZ * back,
          dirX * throwSpeed + (Math.random() - 0.5) * 2 * SPREAD,
          rand(UP_SPEED) * upScale,
          dirZ * throwSpeed + (Math.random() - 0.5) * 2 * SPREAD,
          floorY,
          d,
          isLeaf
        );
      }
    }
  }

  function step(layer, dt, isLeaf) {
    const drag = Math.exp(-(isLeaf ? LEAF_DRAG : CHUNK_DRAG) * dt);
    const bits = layer.bits;
    for (let i = bits.length - 1; i >= 0; i--) {
      const b = bits[i];
      b.life += dt;
      if (b.life >= b.maxLife) {
        bits[i] = bits[bits.length - 1];
        bits.pop();
        continue;
      }
      if (b.landed) continue;
      b.vx *= drag;
      b.vz *= drag;
      b.vy = b.vy * drag + GRAVITY * dt;
      let sway = 0;
      if (isLeaf) sway = Math.sin(b.life * 7 + b.phase) * LEAF_FLUTTER * dt;
      b.x += b.vx * dt + sway;
      b.y += b.vy * dt;
      b.z += b.vz * dt + sway * 0.5;
      b.rx += b.wx * dt;
      b.ry += b.wy * dt;
      b.rz += b.wz * dt;
      if (b.y <= b.floorY && b.vy < 0) {
        b.y = b.floorY;
        if (isLeaf || b.vy > -2) {
          b.landed = true;
          if (isLeaf) b.rx = Math.PI / 2; // settle flat
        } else {
          b.vy *= -CHUNK_BOUNCE;
          b.vx *= 0.5;
          b.vz *= 0.5;
        }
      }
    }
    bits.forEach((b, i) => {
      const shrink = Math.min(1, (b.maxLife - b.life) / SHRINK_S);
      dummy.position.set(b.x, b.y, b.z);
      dummy.rotation.set(b.rx, b.ry, b.rz);
      dummy.scale.set(b.sx * shrink, b.sy * shrink, b.sz * shrink);
      dummy.updateMatrix();
      layer.mesh.setMatrixAt(i, dummy.matrix);
      layer.mesh.setColorAt(i, color.setHex(b.color));
    });
    layer.mesh.count = bits.length;
    layer.mesh.instanceMatrix.needsUpdate = true;
    if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
  }

  return {
    /** Call once per rendered frame; `vehicle` / `world` may be null before a car exists. */
    update(dt, vehicle, world) {
      if (enabled && vehicle && world) emit(dt, vehicle, world);
      step(leaves, dt, true);
      step(chunks, dt, false);
    },

    /** Off: no new debris (bits in flight finish). */
    setEnabled(on) {
      enabled = on;
      if (!on) owed.clear();
    },

    shiftOrigin(dx, dz) {
      // Bits are world positions; undo the scene-wide shift of the meshes themselves.
      for (const layer of [leaves, chunks]) {
        layer.mesh.position.set(0, 0, 0);
        for (const b of layer.bits) {
          b.x -= dx;
          b.z -= dz;
        }
      }
    },
  };
}
