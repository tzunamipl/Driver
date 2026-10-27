// Exhaust pipes: a silencer + tailpipe hung under the rear for each low, rear-facing
// exhaust tip (stacks, side pipes and `breakableExhaust: false` get none). A worn exhaust
// (exhaustDamage.js) sags from its front hanger and swings on a soft spring with the body's motion. It has no
// collision shape: the ground under the tip is estimated from the wheels' contact points,
// and a tip reaching it bounces off, wears the exhaust and throws sparks on hard ground.
// At 0 health it drops off as tumbling debris (knockable.js) and lies where it lands, fading
// away after LYING_S or going once the car is REMOVE_DISTANCE_M from it.
// The body's own modelled tailpipes (meshes tagged `userData.exhaust`) ride on the nearest pipe.
// The scrape sound goes out via onScrape.

import * as THREE from 'three';
import { createSparkles } from './particles/sparkles.js';
import { launchDebris, settleDebris } from './knockable.js';
import { localBounds } from './vehicleShared.js';
import { exhaustTipsOf } from './exhaustFlames.js';

const PIPE_RADIUS = 0.035;
const TAILPIPE_LENGTH = 0.55;
const SILENCER_RADIUS = 0.1;
const SILENCER_LENGTH = 0.45;
const LENGTH = TAILPIPE_LENGTH + SILENCER_LENGTH; // front hanger (pivot) to tip
const TIP_LENGTH = 0.06;
// A tip gets a pipe below the body's mid height, in the rear REAR_SHARE of its length, pointing back.
const REAR_SHARE = 0.3;
const MIN_BACK_DIR = 0.7;
// Below this health the pipe works loose; near 0 it sags MAX_SAG (rad) at rest.
const LOOSE_FROM = 0.75;
const MAX_SAG = 0.4;
const SAG_RANGE = [-0.1, 0.8]; // rad, how far the swing may lift / drop it
const MAX_SWING = 0.3; // rad sideways
// Natural frequency (rad/s): firm when just loose .. floppy near 0 health.
const OMEGA = [22, 7];
const DAMPING_RATIO = 0.12;
const ACCEL_SMOOTH_S = 0.05; // the body's acceleration is a velocity difference per frame: noisy
const MAX_ACCEL = 60; // m/s², so a reset or teleport stopping the car dead doesn't fling the pipe
const RUMBLE = 0.8; // random rad/s² per m/s of speed, at 0 health
const BOUNCE = 0.3;
const MAX_GROUND_SLOPE = 0.3;
const MAX_DT = 0.033;
const SPARK_MIN_SPEED = 1.5; // m/s
const SPARKS_PER_M = 5;
const MAX_SPARKS_PER_S = 200;
const SPARK_SURFACES = { road: 1, builtUp: 1, rock: 1, unpaved: 0.3 };
const SPARK = { speed: [1.5, 5], up: [0.15, 0.6], life: [0.15, 0.4], size: 0.5, spread: 0.05 };
const SPARK_INHERIT = 0.15;
const DEBRIS = { mass: 6, debrisRadius: 0.07, debrisSpheres: [[0, 0, -0.4], [0, 0, 0], [0, 0, 0.4]] };
const DEBRIS_SPIN = 2; // rad/s, random
const LOST_FLAME_DIR = new THREE.Vector3(0, -0.6, -0.8); // pipe gone: flames spit from the cut under the car
const MAX_LYING = 6;
const LYING_S = 60;
const FADE_S = 2; // the last part of LYING_S
const REMOVE_DISTANCE_M = 500;

const pipeMaterial = new THREE.MeshStandardMaterial({ color: 0x3a3634, roughness: 0.55, metalness: 0.6 });
const tipMaterial = new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.3, metalness: 0.9 });
const tailpipeGeometry = new THREE.CylinderGeometry(PIPE_RADIUS, PIPE_RADIUS, TAILPIPE_LENGTH, 10).rotateX(Math.PI / 2);
const silencerGeometry = new THREE.CylinderGeometry(SILENCER_RADIUS, SILENCER_RADIUS, SILENCER_LENGTH, 14).rotateX(Math.PI / 2).scale(1.3, 0.75, 1);
const tipGeometry = new THREE.CylinderGeometry(PIPE_RADIUS * 1.2, PIPE_RADIUS * 1.2, TIP_LENGTH, 10).rotateX(Math.PI / 2);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const inverseQuat = new THREE.Quaternion();
const scratch = new THREE.Vector3();
const accelWorld = new THREE.Vector3();
const pipeMatrix = new THREE.Matrix4();
const inheritScratch = { x: 0, y: 0, z: 0 };

/** Silencer then tailpipe running back (-z) from a pivot group at the front hanger. */
function buildPipe(tip) {
  const pivot = new THREE.Group();
  pivot.position.set(tip.x, tip.y, tip.z + LENGTH);
  const add = (geometry, material, z) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = z;
    mesh.castShadow = true;
    pivot.add(mesh);
  };
  add(silencerGeometry, pipeMaterial, -SILENCER_LENGTH / 2);
  add(tailpipeGeometry, pipeMaterial, -SILENCER_LENGTH - TAILPIPE_LENGTH / 2);
  add(tipGeometry, tipMaterial, -LENGTH + TIP_LENGTH / 2);
  const tipPoint = new THREE.Object3D();
  tipPoint.position.z = -LENGTH;
  pivot.add(tipPoint);
  return { pivot, tipPoint, sag: 0, sagV: 0, swing: 0, swingV: 0 };
}

/** Low, rear-facing tips of the chassis mesh (before any pipe is added to it). */
function pipeTips(tips, chassisMesh) {
  const box = localBounds(chassisMesh);
  const midY = (box.min.y + box.max.y) / 2;
  const rearZ = box.min.z + (box.max.z - box.min.z) * REAR_SHARE;
  return tips.filter(({ pos, dir }) => pos.y < midY && pos.z < rearZ && -dir.z >= MIN_BACK_DIR).map(({ pos }) => pos);
}

/**
 * @param {THREE.Scene} scene
 * @param {import('cannon-es').World} world - for the fallen pipes' debris bodies.
 * @param {{ onScrape?: (dt: number, speed: number, side: number) => void }} [options] - fired once per update with the scraping speed (0 = none), side -1 left .. 1 right.
 */
export function createExhaustPipes(scene, world, { onScrape } = {}) {
  const sparkles = createSparkles(scene);
  const lying = []; // knockable.js debris { mesh, body, age, restAge } + { lyingS, materials }, oldest first
  let vehicle = null;
  let pipes = []; // attached ones, on `vehicle`
  let tips = []; // chassis-local positions with a pipe, for `vehicle`
  let flameTips = []; // chassis-local { pos, dir } per pipe, for exhaustFlames.js
  let bodyPipes = []; // { mesh, matrix }: the body's tagged tailpipes, taken off it; matrix in the content group
  const lastVelocity = new THREE.Vector3();
  const accel = new THREE.Vector3(); // smoothed, chassis-local
  let sparksOwed = 0;

  function attach(chassisMesh) {
    const group = chassisMesh.userData.contentGroup ?? chassisMesh;
    pipes = tips.map((tip) => {
      const pipe = buildPipe(tip);
      group.add(pipe.pivot);
      return pipe;
    });
    for (const { mesh, matrix } of bodyPipes) {
      const x = matrix.elements[12];
      const pipe = pipes.reduce((best, p) => (Math.abs(p.pivot.position.x - x) < Math.abs(best.pivot.position.x - x) ? p : best));
      pipe.pivot.updateMatrix();
      const copy = mesh.clone();
      pipeMatrix.copy(pipe.pivot.matrix).invert().multiply(matrix).decompose(copy.position, copy.quaternion, copy.scale);
      pipe.pivot.add(copy);
    }
  }

  /** Takes the body's tagged tailpipes off it, so the ones on the pipes replace them. */
  function takeBodyPipes(chassisMesh) {
    const group = chassisMesh.userData.contentGroup ?? chassisMesh;
    group.updateMatrixWorld(true);
    const toGroup = group.matrixWorld.clone().invert();
    const tagged = [];
    group.traverse((o) => o.userData.exhaust && tagged.push(o));
    bodyPipes = tagged.map((mesh) => {
      const matrix = toGroup.clone().multiply(mesh.matrixWorld);
      mesh.removeFromParent();
      return { mesh, matrix };
    });
  }

  function bind(nextVehicle, chassisMesh, descriptor) {
    vehicle = nextVehicle;
    pipes = [];
    tips = [];
    flameTips = [];
    bodyPipes = [];
    if (!vehicle?.exhaust?.breakable || !chassisMesh || !descriptor) return;
    const allTips = exhaustTipsOf(descriptor, chassisMesh);
    tips = pipeTips(allTips, chassisMesh);
    flameTips = tips.map(() => ({ pos: new THREE.Vector3(), dir: new THREE.Vector3() }));
    const points = tips.length ? tips : allTips.map((t) => t.pos);
    const anchor = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(points.length);
    vehicle.exhaust.anchor = [anchor.x, anchor.y, anchor.z];
    if (tips.length) takeBodyPipes(chassisMesh);
    lastVelocity.copy(vehicle.chassisBody.velocity);
    accel.set(0, 0, 0);
    if (!vehicle.exhaust.detached) attach(chassisMesh);
  }

  /** Drops the pipes off the car as debris thrown along with it. */
  function detach() {
    const body = vehicle.chassisBody;
    for (const pipe of pipes) {
      const holder = new THREE.Group();
      pipe.pivot.updateWorldMatrix(true, false);
      pipe.pivot.getWorldQuaternion(holder.quaternion);
      holder.position.set(0, 0, -LENGTH / 2).applyMatrix4(pipe.pivot.matrixWorld);
      scene.add(holder);
      holder.attach(pipe.pivot);
      // Own materials, so it can fade without fading the pipes still on cars.
      const materials = [];
      holder.traverse((o) => {
        if (!o.isMesh) return;
        o.material = o.material.clone();
        o.material.transparent = true;
        materials.push(o.material);
      });
      const debris = launchDebris(world, DEBRIS, holder.position, holder.quaternion, body);
      debris.velocity.copy(body.velocity);
      debris.angularVelocity.set((Math.random() - 0.5) * DEBRIS_SPIN, (Math.random() - 0.5) * DEBRIS_SPIN, (Math.random() - 0.5) * DEBRIS_SPIN);
      lying.push({ mesh: holder, body: debris, age: 0, restAge: 0, lyingS: 0, materials });
    }
    pipes = [];
    while (lying.length > MAX_LYING) removeLying(lying.shift());
  }

  function removeLying(debris) {
    scene.remove(debris.mesh);
    if (debris.body) world.removeBody(debris.body);
    for (const material of debris.materials) material.dispose();
  }

  /** Settles the fallen pipes; fades and removes the old ones and the ones far from the car. */
  function updateLying(dt) {
    const car = vehicle?.chassisBody.position;
    for (let i = lying.length - 1; i >= 0; i--) {
      const debris = lying[i];
      settleDebris(world, debris, dt);
      debris.lyingS += dt;
      const p = debris.mesh.position;
      const far = car && Math.hypot(p.x - car.x, p.z - car.z) > REMOVE_DISTANCE_M;
      if (far || debris.lyingS >= LYING_S) {
        removeLying(debris);
        lying.splice(i, 1);
      } else if (debris.lyingS > LYING_S - FADE_S) {
        for (const material of debris.materials) material.opacity = (LYING_S - debris.lyingS) / FADE_S;
      }
    }
  }

  /** Chassis-local ground height under local z, from the wheels' contact points; null in the air. */
  function groundYAt(z) {
    const body = vehicle.chassisBody;
    inverseQuat.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w).invert();
    let rear = 0;
    let rearY = 0;
    let rearZ = 0;
    let front = 0;
    let frontY = 0;
    let frontZ = 0;
    for (const wheel of vehicle.wheelInfos) {
      if (wheel.body !== body || !wheel.isInContact) continue;
      const p = wheel.raycastResult.hitPointWorld;
      scratch.set(p.x - body.position.x, p.y - body.position.y, p.z - body.position.z).applyQuaternion(inverseQuat);
      if (scratch.z < 0) {
        rear++;
        rearY += scratch.y;
        rearZ += scratch.z;
      } else {
        front++;
        frontY += scratch.y;
        frontZ += scratch.z;
      }
    }
    if (!rear && !front) return null;
    if (!rear || !front) return (rearY + frontY) / (rear + front);
    rearY /= rear;
    rearZ /= rear;
    frontY /= front;
    frontZ /= front;
    const slope = clamp((frontY - rearY) / (frontZ - rearZ || 1), -MAX_GROUND_SLOPE, MAX_GROUND_SLOPE);
    return rearY + (z - rearZ) * slope;
  }

  /** Surface under the rearmost grounded wheel. */
  function rearSurface() {
    let surface = null;
    let minZ = Infinity;
    for (const wheel of vehicle.wheelInfos) {
      if (wheel.body !== vehicle.chassisBody || !wheel.isInContact) continue;
      const z = wheel.chassisConnectionPointLocal.z;
      if (z < minZ) {
        minZ = z;
        surface = wheel.surface;
      }
    }
    return surface;
  }

  /** Swing one pipe for `dt`; returns true while its tip is on the ground. */
  function swingPipe(pipe, dt, health, speed) {
    const loose = 1 - health / LOOSE_FROM; // 0 just loose .. 1 at 0 health
    const omega = OMEGA[0] + (OMEGA[1] - OMEGA[0]) * loose;
    const restSag = MAX_SAG * loose;
    const rumble = () => (Math.random() - 0.5) * 2 * RUMBLE * speed * loose;
    // The hanger moves with the body; the pipe lags behind (up = sags more, right = swings left).
    pipe.sagV += (-omega * omega * (pipe.sag - restSag) - 2 * DAMPING_RATIO * omega * pipe.sagV + accel.y / LENGTH + rumble()) * dt;
    pipe.swingV += (-omega * omega * pipe.swing - 2 * DAMPING_RATIO * omega * pipe.swingV + accel.x / LENGTH + rumble()) * dt;
    pipe.sag += pipe.sagV * dt;
    pipe.swing += pipe.swingV * dt;
    pipe.sag = clamp(pipe.sag, SAG_RANGE[0], SAG_RANGE[1]);
    pipe.swing = clamp(pipe.swing, -MAX_SWING, MAX_SWING);

    let onGround = false;
    const pivot = pipe.pivot.position;
    const groundY = groundYAt(pivot.z - LENGTH * Math.cos(pipe.sag));
    if (groundY != null) {
      const maxSag = Math.asin(clamp((pivot.y - groundY - PIPE_RADIUS) / LENGTH, -1, 1));
      if (pipe.sag > maxSag) {
        pipe.sag = maxSag;
        if (pipe.sagV > 0) pipe.sagV *= -BOUNCE;
        onGround = true;
      }
    }
    pipe.pivot.rotation.set(-pipe.sag, pipe.swing, 0);
    return onGround;
  }

  function throwSparks(pipe, count) {
    const p = pipe.tipPoint.getWorldPosition(scratch);
    const v = vehicle.chassisBody.velocity;
    inheritScratch.x = v.x * SPARK_INHERIT;
    inheritScratch.y = v.y * SPARK_INHERIT;
    inheritScratch.z = v.z * SPARK_INHERIT;
    sparkles.throw(p.x, p.y - PIPE_RADIUS, p.z, { ...SPARK, count, inherit: inheritScratch });
  }

  /**
   * Per rendered frame.
   * @param {number} dt - frame delta in seconds.
   * @param {object|null} nextVehicle - wheeledVehicle.js vehicle (with .exhaust), or null.
   * @param {THREE.Object3D|null} chassisMesh
   * @param {object|null} descriptor - vehicle descriptor (exhaustTips).
   */
  function update(dt, nextVehicle, chassisMesh, descriptor) {
    sparkles.update(dt);
    updateLying(dt);
    if (nextVehicle !== vehicle) bind(nextVehicle, chassisMesh, descriptor);
    let scrapeSpeed = 0;
    let scrapeSide = 0;
    const exhaust = vehicle?.exhaust;
    if (exhaust && tips.length && dt > 0) {
      if (exhaust.detached && pipes.length) detach();
      else if (!exhaust.detached && !pipes.length) attach(chassisMesh);

      const step = Math.min(dt, MAX_DT);
      const velocity = vehicle.chassisBody.velocity;
      accelWorld.set(velocity.x - lastVelocity.x, velocity.y - lastVelocity.y, velocity.z - lastVelocity.z).divideScalar(dt).clampLength(0, MAX_ACCEL);
      lastVelocity.copy(velocity);
      const body = vehicle.chassisBody;
      inverseQuat.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w).invert();
      accel.lerp(accelWorld.applyQuaternion(inverseQuat), Math.min(1, dt / ACCEL_SMOOTH_S));

      const speed = Math.hypot(velocity.x, velocity.z);
      const loose = exhaust.health < LOOSE_FROM;
      let scraping = null;
      for (const pipe of pipes) {
        if (!loose) {
          pipe.sag = pipe.sagV = pipe.swing = pipe.swingV = 0;
          pipe.pivot.rotation.set(0, 0, 0);
          continue;
        }
        if (swingPipe(pipe, step, exhaust.health, speed)) scraping = pipe;
      }
      if (scraping && speed > SPARK_MIN_SPEED) {
        scrapeSpeed = speed;
        scrapeSide = -Math.sign(scraping.pivot.position.x);
        if (!vehicle.noDamage) exhaust.scrape(speed * dt);
        sparksOwed += Math.min(MAX_SPARKS_PER_S, speed * SPARKS_PER_M) * (SPARK_SURFACES[rearSurface()] ?? 0) * dt;
        const count = Math.floor(sparksOwed);
        sparksOwed -= count;
        if (count) throwSparks(scraping, count);
      } else {
        sparksOwed = 0;
      }
    }
    onScrape?.(dt, scrapeSpeed, scrapeSide);
  }

  /** Chassis-local flame tips: the swinging pipes' ends, or under the car where they hung; null without pipes. */
  function getFlameTips() {
    if (!vehicle || !tips.length) return null;
    tips.forEach((tip, i) => {
      const out = flameTips[i];
      const pipe = pipes[i];
      if (pipe) {
        out.dir.set(0, 0, -1).applyQuaternion(pipe.pivot.quaternion);
        out.pos.copy(pipe.pivot.position).addScaledVector(out.dir, LENGTH);
      } else {
        out.pos.set(tip.x, tip.y, tip.z + LENGTH);
        out.dir.copy(LOST_FLAME_DIR).normalize();
      }
    });
    return flameTips;
  }

  /** Floating-origin shift (the debris meshes and bodies move with the scene and world). */
  function shiftOrigin(dx, dz) {
    sparkles.shiftOrigin(dx, dz);
  }

  return { update, getFlameTips, shiftOrigin };
}
