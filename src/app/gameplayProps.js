import { SCORE_PER_PEDESTRIAN, SCORING_ENABLED, PEDESTRIANS_ENABLED } from '../config.js';

// Wires pedestrian hits and the shared-room "props" channel (hits, shots,
// balls someone else already spawned) together. Split out from the main
// loop since this is gameplay/networking glue with no per-frame physics of
// its own (balls' per-frame sync still happens in the main loop).

// Positions arrive in the network frame; `viewFrame` maps them to ours.
export function setupGameplayProps({ pedestrians, balls, shots, net, carManager, scoreToast, viewFrame }) {
  const toView = (msg) => ({ ...msg, ...viewFrame.fromNetwork(msg.x, msg.z) });

  pedestrians.setOnHit((pedId, hit) => {
    if (SCORING_ENABLED) {
      carManager.addScore(SCORE_PER_PEDESTRIAN);
      scoreToast?.push(SCORE_PER_PEDESTRIAN, 'pedestrian');
    }
    net.publishProps({ type: 'ped-hit', pedId, vx: hit.vx, vy: hit.vy, vz: hit.vz });
  });

  net.onProps((msg) => {
    // Older clients still broadcast their pedestrians; don't adopt them.
    if (!PEDESTRIANS_ENABLED && (msg.type === 'peds' || msg.type === 'ped-hit')) return;
    if (msg.type === 'peds' && Array.isArray(msg.peds)) {
      for (const ped of msg.peds) {
        const { x, z } = viewFrame.fromNetwork(ped.x, ped.z);
        pedestrians.addPed(ped.id, x, ped.y, z);
      }
    } else if (msg.type === 'ped-hit') {
      pedestrians.knockFromRemote(msg.pedId, msg);
    } else if (msg.type === 'shot') {
      shots.spawnRemote(toView(msg));
    } else if (msg.type === 'ball' || msg.type === 'ball-spawn') {
      balls.ensureRemote(msg.ballId, toView(msg));
    }
  });

}
