// Default chase camera. Every tunable it needs (offset, smoothing speeds,
// close-up scaling, pitch...) is already the shared baseline in
// config.js, so this descriptor only has to state its identity - nothing
// here overrides a shared default, which is exactly what makes it the
// "default" view (see ../cameraFollow.js's `view.field ?? SHARED_DEFAULT`
// merge and ./index.js's registry).
export default {
  id: 'chase',
  label: 'Chase',
};
