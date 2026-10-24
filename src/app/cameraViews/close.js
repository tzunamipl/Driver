// Tighter chase camera: same velocity-yaw/smoothing behavior as the
// default chase view (shared with it via config.js's CAMERA_* baseline -
// see ../cameraFollow.js's merge), just a shorter, lower offset for a
// more intimate framing. Everything not listed here (smoothing speeds,
// pitch, close-up scaling...) still falls back to the shared defaults,
// same as every other view's descriptor.
export default {
  id: 'close',
  label: 'Close Chase',
  wheelStereo: true,
  offset: [0, 6, -11],
  lookAtOffset: [0, 4, 8],
  closeScaleAtMaxSpeed: 0.6, // same distance as when slow
  positionLeadFactor: 0.9, // no lag at steady speed
  accelLag: 0.5, // m per m/s²: drops back while accelerating, catches up once speed evens out
};
