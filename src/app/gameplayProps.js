// Wires the pedestrian/ball spawn buttons and the shared-room "props"
// channel (spawns, hits) together. Split out from the main loop since this
// is pure gameplay/networking glue with no per-frame physics of its own
// (balls' per-frame sync still happens in the main loop via balls.syncMeshes()).

export function setupGameplayProps({ pedestrians, balls, net, carManager, isJoined }) {
  const spawnPedsBtn = document.getElementById('spawn-peds');
  const spawnBallBtn = document.getElementById('spawn-ball');

  pedestrians.setOnHit((pedId) => {
    carManager.addScore(1);
    net.publishProps({ type: 'ped-hit', pedId });
  });

  net.onProps((msg) => {
    if (msg.type === 'peds' && Array.isArray(msg.peds)) {
      for (const ped of msg.peds) pedestrians.addPed(ped.id, ped.x, ped.y, ped.z);
    } else if (msg.type === 'ped-hit') {
      pedestrians.removePed(msg.pedId);
    } else if (msg.type === 'ball' || msg.type === 'ball-spawn') {
      balls.ensureRemote(msg.ballId, msg);
    }
  });

  spawnPedsBtn.addEventListener('click', () => {
    const vehicle = carManager.getVehicle();
    if (!isJoined() || !vehicle) return;
    const batch = pedestrians.spawnLocal(vehicle.chassisBody, net.clientId);
    net.publishProps({ type: 'peds', peds: batch });
  });

  spawnBallBtn.addEventListener('click', () => {
    const vehicle = carManager.getVehicle();
    if (!isJoined() || !vehicle) return;
    const spawned = balls.spawnOwned(vehicle.chassisBody, net.clientId);
    net.publishProps({ type: 'ball-spawn', ...spawned });
  });

  return {
    setButtonsEnabled(enabled) {
      spawnPedsBtn.disabled = !enabled;
      spawnBallBtn.disabled = !enabled;
    },
  };
}
