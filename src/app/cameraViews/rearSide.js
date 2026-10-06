// Rear-quarter dash cam: rigidly mounted like ./hood.js (`rigid: true` -
// see ../cameraFollow.js's updateRigid()), but parked behind and off to
// one side of the car instead of on the hood looking down the road. The
// point is framing, not following: offset puts the camera a few metres
// back and to the right so the whole chassis - both axles' wheels
// included - stays in frame, and lookAtOffset aims a bit forward of the
// chassis center (roughly the front-wheel line) so the shot reads as a
// deliberate three-quarter-rear angle instead of a flat side-on view.
export default {
  id: 'rearSide',
  label: 'Rear Quarter',
  rigid: true,
  offset: [2.6, 2.0, -5.0],
  lookAtOffset: [-0.3, 0.4, 1.0],
};
