// Hood/bumper camera: rigidly mounted to the chassis instead of chasing
// it from behind. Unlike every other view (chase/close/far - all driven
// by ../cameraFollow.js's velocity-yaw + exponential-smoothing chase
// logic), `rigid: true` tells cameraFollow.js to skip that whole pipeline
// and just parent the camera straight to the chassis transform each
// frame - no yaw/pitch/position smoothing, no velocity-direction framing,
// since a dashboard-mounted camera shouldn't lag or swing independently
// of the car at all. offset/lookAtOffset here are in the chassis' own
// local space (not world-relative like the chase views' offsets).
export default {
  id: 'hood',
  label: 'Hood',
  rigid: true,
  offset: [0, 1.3, 1.6],
  lookAtOffset: [0, 1.0, 10],
};
