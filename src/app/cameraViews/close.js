// Tighter chase camera: same velocity-yaw/smoothing behavior as the
// default chase view (shared with it via config.js's CAMERA_* baseline -
// see ../cameraFollow.js's merge), just a shorter, lower offset for a
// more intimate framing. Everything not listed here (smoothing speeds,
// pitch, close-up scaling...) still falls back to the shared defaults,
// same as every other view's descriptor.
export default {
  id: 'close',
  label: 'Close Chase',
  offset: [0, 10, -16],
  lookAtOffset: [0, 4, 8],
};
