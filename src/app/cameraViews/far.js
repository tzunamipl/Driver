// Wide "cinematic" chase camera: farther back/higher up than the default
// chase view, and panned noticeably lazier (lower position/look-at
// smoothing speeds) so it reads as a deliberate, sweeping establishing
// shot rather than a tight pursuit cam. Only the fields that actually
// differ from the shared baseline (config.js's CAMERA_*) are listed here
// - everything else (yaw/pitch smoothing, close-up scaling...) still
// comes from there via ../cameraFollow.js's merge.
export default {
  id: 'far',
  label: 'Cinematic',
  offset: [0, 30, -48],
  lookAtOffset: [0, 6, 14],
  positionSpeed: 2,
  lookAtSpeed: 20,
};
