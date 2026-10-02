// Shared "category tabs + vehicle list" widget built on top of the vehicle
// registry (see lib/vehicles/index.js). Used both by the lobby's join-time
// picker (ui/lobby.js) and the always-available instant picker in the
// debug view (hud/vehicleDebugPicker.js) - one implementation so adding a
// vehicle/category only ever needs registry changes, never UI changes in
// either caller.

import { CATEGORIES, DEFAULT_VEHICLE_ID, getVehicle, vehiclesInCategory } from '../lib/vehicles/index.js';

/**
 * @param {object} deps
 * @param {HTMLElement} deps.tabsEl - container the category tab buttons are rendered into.
 * @param {HTMLElement} deps.listEl - container the active category's vehicle buttons are rendered into.
 * @param {string} [deps.initialVehicleId] - preselected vehicle (defaults to DEFAULT_VEHICLE_ID).
 * @param {(vehicleId: string) => void} [deps.onSelect] - called whenever the user picks a (different) vehicle.
 */
export function createVehiclePicker({ tabsEl, listEl, initialVehicleId = DEFAULT_VEHICLE_ID, onSelect }) {
  let activeCategoryId = getVehicle(initialVehicleId).category;
  let selectedVehicleId = getVehicle(initialVehicleId).id;

  function renderTabs() {
    tabsEl.innerHTML = '';
    for (const category of CATEGORIES) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'vehicle-tab';
      tab.textContent = category.label;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(category.id === activeCategoryId));
      tab.classList.toggle('active', category.id === activeCategoryId);
      tab.addEventListener('click', () => {
        if (activeCategoryId === category.id) return;
        activeCategoryId = category.id;
        renderTabs();
        renderList();
      });
      tabsEl.appendChild(tab);
    }
  }

  function renderList() {
    listEl.innerHTML = '';
    const vehicles = vehiclesInCategory(activeCategoryId);
    if (vehicles.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'vehicle-empty';
      empty.textContent = 'No vehicles here yet.';
      listEl.appendChild(empty);
      return;
    }
    for (const vehicle of vehicles) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'vehicle-item';
      item.textContent = vehicle.name;
      item.classList.toggle('active', vehicle.id === selectedVehicleId);
      item.addEventListener('click', () => {
        if (selectedVehicleId === vehicle.id) return;
        selectedVehicleId = vehicle.id;
        renderList();
        onSelect?.(selectedVehicleId);
      });
      listEl.appendChild(item);
    }
  }

  /** Jumps the picker to a specific vehicle (e.g. restoring a saved choice) without firing onSelect. */
  function select(vehicleId) {
    const vehicle = getVehicle(vehicleId);
    selectedVehicleId = vehicle.id;
    activeCategoryId = vehicle.category;
    renderTabs();
    renderList();
  }

  renderTabs();
  renderList();

  return {
    getSelectedId: () => selectedVehicleId,
    select,
  };
}
