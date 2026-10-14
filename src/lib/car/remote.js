// Visual-only wheeled car for other players: body + wheels spun from the
// replicated speed, no physics.

import { createRemoteShell } from '../vehicleShared.js';
import { CHASSIS_WIDTH, CHASSIS_HEIGHT, CHASSIS_LENGTH, AXLE_HALF_WIDTH, WHEEL_FRONT_Z, WHEEL_BACK_Z } from './chassis.js';
import { wheelRadiusOf, buildWheelMesh } from './wheelMesh.js';

export function createRemoteWheeledCar(scene, color, name, score, descriptor) {
  const { group, bodyMat } = descriptor.buildBody(CHASSIS_WIDTH, CHASSIS_LENGTH, color);
  const wheelRadius = wheelRadiusOf(descriptor);
  const y = -CHASSIS_HEIGHT / 2;
  const wheelLocals = [
    [-AXLE_HALF_WIDTH, y, WHEEL_FRONT_Z],
    [AXLE_HALF_WIDTH, y, WHEEL_FRONT_Z],
    [-AXLE_HALF_WIDTH, y, WHEEL_BACK_Z],
    [AXLE_HALF_WIDTH, y, WHEEL_BACK_Z],
  ];
  const wheelMeshes = wheelLocals.map(([x, wy, z]) => {
    const wheel = buildWheelMesh(descriptor, group);
    wheel.position.set(x, wy, z);
    wheel.rotation.order = 'YXZ';
    return wheel;
  });
  const shell = createRemoteShell(scene, group, bodyMat, color, name, score);

  let spin = 0;
  function setPose(pose, dt) {
    group.position.set(pose.x, pose.y, pose.z);
    group.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw).normalize();
    spin = (spin + (pose.speed / wheelRadius) * dt) % (Math.PI * 2);
    wheelMeshes.forEach((wheel, i) => {
      wheel.rotation.y = i < 2 ? pose.steer : 0;
      wheel.rotation.x = spin;
    });
  }

  return { setPose, ...shell };
}
