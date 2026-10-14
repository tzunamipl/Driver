// Pod cam (hover only): rigid view whose position rides the chariot's pod
// (mountPoint 'pod' - chassisMesh is the centre engine) and which aims at
// the centre engine (lookAtTarget 'chassis'), since the pod's own facing
// lags. offset is local to the pod, lookAtOffset to the engine.
export default {
  id: 'pod',
  label: 'Pod Cam',
  rigid: true,
  mountPoint: 'pod',
  lookAtTarget: 'chassis',
  vehicleTypes: ['hover'],
  // Seated driver's eye level.
  offset: [0, 0.3, 0],
  // Just above the centre engine.
  lookAtOffset: [0, 0.1, 0],
};

