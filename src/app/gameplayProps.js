import { SCORE_PER_PEDESTRIAN } from '../config.js';

// Wires pedestrian hits and the shared-room "props" channel (hits, shots,
// balls someone else already spawned) together. Split out from the main
// loop since this is gameplay/networking glue with no per-frame physics of
// its own (balls' per-frame sync still happens in the main loop).

export function setupGameplayProps({ pedestrians, balls, shots, net, carManager, scoreToast }) {
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
    } else if (msg.type === 'shot') {
      shots.spawnRemote(msg);
    } else if (msg.type === 'ball' || msg.type === 'ball-spawn') {
      balls.ensureRemote(msg.ballId, msg);
    }
  });

}
