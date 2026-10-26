// Visual-only wheeled car for other players: body + wheels spun from the
// replicated speed and steered from the replicated steer input, no physics.

import * as THREE from 'three';
import { createRemoteShell } from '../vehicleShared.js';
import { CHASSIS_WIDTH, CHASSIS_HEIGHT, CHASSIS_LENGTH } from './chassis.js';
import { wheelRadiusOf, buildWheelSet } from './wheelMesh.js';
import { resolveAxles, layoutWheels, createSteeringGeometry } from './axles.js';

function addWheelMeshes(spec, parent, axles, attachY) {
  return layoutWheels(axles, attachY).map((w) => {
    const wheelSpec = w.axle.wheel ? { ...spec, ...w.axle.wheel } : spec;
    const mesh = buildWheelSet(wheelSpec, parent, w.axle.dual, w.side);
    mesh.position.set(w.x, w.y, w.z);
    mesh.rotation.order = 'YXZ';
    return { ...w, mesh, radius: wheelRadiusOf(wheelSpec) };
  });
}

/** Trailer group parented to the tractor; posed from the replicated trailer quaternion. */
function createRemoteTrailer(descriptor, group, color) {
  const spec = { ...descriptor, ...descriptor.trailer };
  const { group: trailerGroup } = spec.buildBody(color);
  group.add(trailerGroup);
  const wheels = addWheelMeshes(spec, trailerGroup, resolveAxles(spec.axles), spec.wheelAttachY ?? -CHASSIS_HEIGHT / 2);
  const hitch = new THREE.Vector3(...spec.hitch);
  const kingpin = new THREE.Vector3(...spec.kingpin);
  const worldQuat = new THREE.Quaternion();
  const offset = new THREE.Vector3();

  function place(tractorQuat, trailerQuat) {
    if (trailerQuat) {
      worldQuat.set(trailerQuat[0], trailerQuat[1], trailerQuat[2], trailerQuat[3]).normalize();
      trailerGroup.quaternion.copy(tractorQuat).invert().multiply(worldQuat);
    } else {
      trailerGroup.quaternion.identity();
    }
    offset.copy(kingpin).applyQuaternion(trailerGroup.quaternion);
    trailerGroup.position.copy(hitch).sub(offset);
  }
  place(group.quaternion, null);

  return { wheels, radius: wheelRadiusOf(spec), place };
}

export function createRemoteWheeledCar(scene, color, name, score, descriptor) {
  const { group, bodyMat } = descriptor.buildBody(CHASSIS_WIDTH, CHASSIS_LENGTH, color);
  const axles = resolveAxles(descriptor.axles);
  const wheels = addWheelMeshes(descriptor, group, axles, descriptor.wheelAttachY ?? -CHASSIS_HEIGHT / 2);
  const steering = createSteeringGeometry(axles, descriptor);
  const steerAngles = new Array(wheels.length).fill(0);
  const trailer = descriptor.trailer ? createRemoteTrailer(descriptor, group, color) : null;
  const shell = createRemoteShell(scene, group, bodyMat, color, name, score);

  let travel = 0; // metres rolled; each wheel spins by its own radius
  let trailerSpin = 0;
  function setPose(pose, dt) {
    group.position.set(pose.x, pose.y, pose.z);
    group.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw).normalize();
    travel += pose.speed * dt;
    steering.angles(pose.steer, pose.speed * 3.6, wheels, steerAngles);
    wheels.forEach((wheel, i) => {
      wheel.mesh.rotation.y = steerAngles[i];
      wheel.mesh.rotation.x = (travel / wheel.radius) % (Math.PI * 2);
    });
    if (trailer) {
      trailer.place(group.quaternion, pose.trailerQuat);
      trailerSpin = (trailerSpin + (pose.speed / trailer.radius) * dt) % (Math.PI * 2);
      for (const wheel of trailer.wheels) wheel.mesh.rotation.x = trailerSpin;
    }
  }

  const wheelMeshes = [...wheels, ...(trailer?.wheels ?? [])].map((w) => w.mesh);
  return { setPose, wheelMeshes, ...shell };
}
