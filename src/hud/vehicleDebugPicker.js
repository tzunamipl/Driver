// Instant vehicle picker for the debug view (toggled with M alongside
// #suspension-hud/#terrain-stats, see hud/debugVisuals.js). Reuses the same
// tabs + list widget as the lobby (ui/vehiclePicker.js) but, instead of just
// recording a choice to join with, swaps the local car's vehicle kind live
// via carManager.setVehicleKind() and broadcasts it to peers via
// net.setVehicleId().

import { createVehiclePicker } from '../ui/vehiclePicker.js';

/**
 * @param {object} deps
 * @param {import('../app/carManager.js').CarManager} deps.carManager
 * @param {ReturnType<import('../lib/net.js').createNet>} deps.net
 * @param {HTMLElement} deps.tabsEl
 * @param {HTMLElement} deps.listEl
 */
export function createVehicleDebugPicker({ carManager, net, tabsEl, listEl }) {
  const picker = createVehiclePicker({
    tabsEl,
    listEl,
    initialVehicleId: carManager.getVehicleId(),
    onSelect: (vehicleId) => {
      carManager.setVehicleKind(vehicleId);
      net.setVehicleId(vehicleId);
    },
  });

  return {
    // Re-highlights whatever vehicle the car actually is - call after the
    // local car (re)spawns (e.g. on join) so this panel never disagrees
    // with the lobby's choice.
    syncFromCar: () => picker.select(carManager.getVehicleId()),
  };
}
