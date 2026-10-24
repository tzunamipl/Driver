// Contact shadow: a soft dark patch on the ground under each car, so a car
// still sits on the ground where the sun's shadow map doesn't reach (night,
// shade, low sun). Fades out as the car rises off the ground.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GROUND_COLLISION_GROUP } from './terrain.js';

const OPACITY = 0.85;
const FOOTPRINT_SCALE = 1.15; // patch size vs the body's x/z extent
const FADE_START_M = 0.5; // body-bottom clearance where fading starts
const FADE_END_M = 3; // ...and where the patch is gone
const SPREAD_PER_M = 0.15; // patch grows by this fraction per metre of clearance
const LIFT_M = 0.04; // above the hit point, against z-fighting
const RAY_UP_M = 1;
const RAY_DOWN_M = FADE_END_M + 5;
const TEXTURE_SIZE = 128;
const EDGE_SOFTNESS = 0.35; // fraction of the half-size that blurs out

/** Soft rounded rectangle, alpha in the red channel (alphaMap). */
function createShadowTexture() {
  const size = TEXTURE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const inner = 1 - EDGE_SOFTNESS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = Math.abs(((x + 0.5) / size) * 2 - 1);
      const v = Math.abs(((y + 0.5) / size) * 2 - 1);
      // Rounded-box distance past the solid core, 0..1 across the soft edge.
      const dx = Math.max(u - inner, 0);
      const dy = Math.max(v - inner, 0);
      const t = Math.min(Math.hypot(dx, dy) / EDGE_SOFTNESS, 1);
      const a = Math.round(255 * (1 - t * t * (3 - 2 * t)));
      const i = (y * size + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = a;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return new THREE.CanvasTexture(canvas);
}

const _inverse = new THREE.Matrix4();
const _relative = new THREE.Matrix4();
const _meshBox = new THREE.Box3();

/** Box of the visible meshes in `root`'s own frame (sprites like name tags left out). */
function localBounds(root) {
  root.updateMatrixWorld(true);
  _inverse.copy(root.matrixWorld).invert();
  const box = new THREE.Box3();
  root.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    _relative.multiplyMatrices(_inverse, o.matrixWorld);
    box.union(_meshBox.copy(o.geometry.boundingBox).applyMatrix4(_relative));
  });
  return box.isEmpty() ? null : box;
}

/** Call update(casters) every frame with the body meshes to shade under. */
export function createCarShadows(world, scene) {
  const alphaMap = createShadowTexture();
  const geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const shadows = new Map(); // caster Object3D -> { mesh, box }

  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const rayResult = new CANNON.RaycastResult();
  const rayOptions = { collisionFilterMask: GROUND_COLLISION_GROUP };
  const centre = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const basis = new THREE.Matrix4();

  function create(caster) {
    const box = localBounds(caster);
    if (!box) return null;
    const material = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap, transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = -1; // under other transparent effects (dust, smoke)
    scene.add(mesh);
    return { mesh, box };
  }

  function place(caster, { mesh, box }) {
    caster.updateMatrixWorld(); // posed this frame, not yet rendered
    centre.set((box.min.x + box.max.x) / 2, 0, (box.min.z + box.max.z) / 2);
    caster.localToWorld(centre);
    rayFrom.set(centre.x, centre.y + RAY_UP_M, centre.z);
    rayTo.set(centre.x, centre.y - RAY_DOWN_M, centre.z);
    rayResult.reset();
    world.raycastClosest(rayFrom, rayTo, rayOptions, rayResult);
    if (!rayResult.hasHit) return false;
    const hit = rayResult.hitPointWorld;
    const clearance = centre.y - hit.y + box.min.y;
    const fade = 1 - THREE.MathUtils.smoothstep(clearance, FADE_START_M, FADE_END_M);
    if (fade <= 0) return false;

    normal.copy(rayResult.hitNormalWorld);
    forward.set(0, 0, 1).applyQuaternion(caster.quaternion);
    forward.addScaledVector(normal, -forward.dot(normal));
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1); // nose straight down
    forward.normalize();
    right.crossVectors(normal, forward);
    const spread = 1 + Math.max(clearance, 0) * SPREAD_PER_M;
    basis.makeBasis(
      right.multiplyScalar((box.max.x - box.min.x) * FOOTPRINT_SCALE * spread),
      normal,
      forward.multiplyScalar((box.max.z - box.min.z) * FOOTPRINT_SCALE * spread)
    );
    basis.setPosition(hit.x + normal.x * LIFT_M, hit.y + normal.y * LIFT_M, hit.z + normal.z * LIFT_M);
    mesh.matrix.copy(basis);
    mesh.matrixWorldNeedsUpdate = true;
    // Spread thins it out, so a bigger patch isn't darker overall.
    mesh.material.opacity = (OPACITY * fade) / spread;
    return true;
  }

  function remove(caster) {
    const shadow = shadows.get(caster);
    scene.remove(shadow.mesh);
    shadow.mesh.material.dispose();
    shadows.delete(caster);
  }

  /** @param {THREE.Object3D[]} casters - body meshes in the scene, posed for this frame. */
  function update(casters) {
    const seen = new Set();
    for (const caster of casters) {
      if (!caster?.parent) continue;
      seen.add(caster);
      let shadow = shadows.get(caster);
      if (!shadow) {
        shadow = create(caster);
        if (!shadow) continue;
        shadows.set(caster, shadow);
      }
      shadow.mesh.visible = caster.visible && place(caster, shadow);
    }
    for (const caster of shadows.keys()) if (!seen.has(caster)) remove(caster);
  }

  return { update };
}
