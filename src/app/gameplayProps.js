import { SCORE_PER_PEDESTRIAN } from '../config.js';

// Wires the pedestrian/ball spawn buttons and the shared-room "props"
// channel (spawns, hits) together. Split out from the main loop since this
// is pure gameplay/networking glue with no per-frame physics of its own
// (balls' per-frame sync still happens in the main loop via balls.syncMeshes()).

export function setupGameplayProps({ pedestrians, balls, net, carManager, isJoined, scoreToast }) {
  const spawnBallBtn = document.getElementById('spawn-ball');

  pedestrians.setOnHit((pedId, hit) => {
    carManager.addScore(SCORE_PER_PEDESTRIAN);
    scoreToast?.push(SCORE_PER_PEDESTRIAN, 'pedestrian');
    net.publishProps({ type: 'ped-hit', pedId, vx: hit.vx, vy: hit.vy, vz: hit.vz });
  });

  net.onProps((msg) => {
    if (msg.type === 'peds' && Array.isArray(msg.peds)) {
      for (const ped of msg.peds) pedestrians.addPed(ped.id, ped.x, ped.y, ped.z);
    } else if (msg.type === 'ped-hit') {
      pedestrians.knockFromRemote(msg.pedId, msg);
    } else if (msg.type === 'ball' || msg.type === 'ball-spawn') {
      balls.ensureRemote(msg.ballId, msg);
    }
  });

  spawnBallBtn.addEventListener('click', () => {
    const vehicle = carManager.getVehicle();
    if (!isJoined() || !vehicle) return;
    const spawned = balls.spawnOwned(vehicle.chassisBody, net.clientId);
    net.publishProps({ type: 'ball-spawn', ...spawned });
  });

  return {
    setButtonsEnabled(enabled) {
      spawnBallBtn.disabled = !enabled;
    },
  };
}
