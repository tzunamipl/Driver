// Contact shadow: a soft dark patch on the ground under each car and each of
// its wheels, so a car still sits on the ground where the sun's shadow map
// doesn't reach (night, shade, low sun). Fades out as it rises off the ground.

import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { GROUND_COLLISION_GROUP } from './terrain.js';

// fadeStart/fadeEnd = bottom clearance where fading starts / the patch is gone;
// spread = patch growth per metre of clearance; edgeSoftness = fraction of the
// half-size that blurs out (1 = round blob).
const BODY = {
  opacity: 0.75,
  scaleX: 1.15, // patch size vs the box's x/z extent
  scaleZ: 1.15,
  fadeStart: 0.5,
  fadeEnd: 3,
  spread: 0.15,
  edgeSoftness: 0.35,
  heading: 'forward', // local z = nose
};
const WHEEL = {
  opacity: 0.9,
  scaleX: 1.7,
  scaleZ: 1.75, // a short patch around the contact, not the whole diameter
  fadeStart: 0.03,
  fadeEnd: 0.6,
  spread: 0.8,
  edgeSoftness: 0.8,
  heading: 'axle', // local x stays put while the wheel spins
};
const LIFT_M = 0.04; // above the hit point, against z-fighting
const WHEEL_LIFT_M = 0.05; // drawn over the body patch
const RAY_UP_M = 1;
const RAY_DOWN_M = BODY.fadeEnd + 5;
const TEXTURE_SIZE = 128;

/** Soft rounded rectangle, alpha in the red channel (alphaMap). */
function createShadowTexture(edgeSoftness) {
  const size = TEXTURE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const inner = 1 - edgeSoftness;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = Math.abs(((x + 0.5) / size) * 2 - 1);
      const v = Math.abs(((y + 0.5) / size) * 2 - 1);
      // Rounded-box distance past the solid core, 0..1 across the soft edge.
      const dx = Math.max(u - inner, 0);
      const dy = Math.max(v - inner, 0);
      const t = Math.min(Math.hypot(dx, dy) / edgeSoftness, 1);
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

/** Call update(bodies, wheels) every frame with the meshes to shade under. */
export function createCarShadows(world, scene) {
  const alphaMaps = new Map([BODY, WHEEL].map((p) => [p, createShadowTexture(p.edgeSoftness)]));
  const geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const shadows = new Map(); // caster Object3D -> { mesh, box, profile }

  const rayFrom = new CANNON.Vec3();
  const rayTo = new CANNON.Vec3();
  const rayResult = new CANNON.RaycastResult();
  const rayOptions = { collisionFilterMask: GROUND_COLLISION_GROUP };
  const centre = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const worldQuat = new THREE.Quaternion();

  function create(caster, profile) {
    const box = localBounds(caster);
    if (!box) return null;
    const alphaMap = alphaMaps.get(profile);
    const material = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap, transparent: true, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = -1; // under other transparent effects (dust, smoke)
    scene.add(mesh);
    if (profile === WHEEL) {
      // Spin-proof footprint: tyre width across, diameter along.
      const diameter = Math.max(box.max.y - box.min.y, box.max.z - box.min.z);
      const cz = (box.min.z + box.max.z) / 2;
      box.min.z = cz - diameter / 2;
      box.max.z = cz + diameter / 2;
      box.min.y = (box.min.y + box.max.y) / 2 - diameter / 2;
    }
    return { mesh, box, profile };
  }

  function place(caster, { mesh, box, profile }) {
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
    const fade = 1 - THREE.MathUtils.smoothstep(clearance, profile.fadeStart, profile.fadeEnd);
    if (fade <= 0) return false;

    normal.copy(rayResult.hitNormalWorld);
    caster.getWorldQuaternion(worldQuat); // wheels sit in a car group remotely
    if (profile.heading === 'axle') {
      right.set(1, 0, 0).applyQuaternion(worldQuat);
      right.addScaledVector(normal, -right.dot(normal));
      if (right.lengthSq() < 1e-6) return false; // wheel lying flat
      right.normalize();
      forward.crossVectors(right, normal);
    } else {
      forward.set(0, 0, 1).applyQuaternion(worldQuat);
      forward.addScaledVector(normal, -forward.dot(normal));
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1); // nose straight down
      forward.normalize();
      right.crossVectors(normal, forward);
    }
    const spread = 1 + Math.max(clearance, 0) * profile.spread;
    basis.makeBasis(
      right.multiplyScalar((box.max.x - box.min.x) * profile.scaleX * spread),
      normal,
      forward.multiplyScalar((box.max.z - box.min.z) * profile.scaleZ * spread)
    );
    const lift = profile === WHEEL ? WHEEL_LIFT_M : LIFT_M;
    basis.setPosition(hit.x + normal.x * lift, hit.y + normal.y * lift, hit.z + normal.z * lift);
    mesh.matrix.copy(basis);
    mesh.matrixWorldNeedsUpdate = true;
    // Spread thins it out, so a bigger patch isn't darker overall.
    mesh.material.opacity = (profile.opacity * fade) / spread;
    return true;
  }

  function remove(caster) {
    const shadow = shadows.get(caster);
    scene.remove(shadow.mesh);
    shadow.mesh.material.dispose();
    shadows.delete(caster);
  }

  const seen = new Set();
  function shade(casters, profile) {
    for (const caster of casters) {
      if (!caster?.parent) continue;
      seen.add(caster);
      let shadow = shadows.get(caster);
      if (!shadow) {
        shadow = create(caster, profile);
        if (!shadow) continue;
        shadows.set(caster, shadow);
      }
      shadow.mesh.visible = caster.visible && place(caster, shadow);
    }
  }

  /**
   * @param {THREE.Object3D[]} bodies - body meshes in the scene, posed for this frame.
   * @param {THREE.Object3D[]} wheels - wheel meshes (or dual sets), posed for this frame.
   */
  function update(bodies, wheels = []) {
    seen.clear();
    shade(bodies, BODY);
    shade(wheels, WHEEL);
    for (const caster of shadows.keys()) if (!seen.has(caster)) remove(caster);
  }

  return { update };
}
