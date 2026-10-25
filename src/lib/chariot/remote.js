// Visual-only Chariot of Fire for other players: one rigid group (descriptor.buildBody)
// posed from the replicated transform - per-engine physics isn't replicated.

import { createRemoteShell } from '../vehicleShared.js';

export function createRemoteChariot(scene, color, name, score, descriptor) {
  const { group, bodyMat } = descriptor.buildBody(0, 0, color);
  const shell = createRemoteShell(scene, group, bodyMat, color, name, score);

  function setPose(pose) {
    group.position.set(pose.x, pose.y, pose.z);
    group.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw).normalize();
  }

  return { setPose, ...shell };
}
