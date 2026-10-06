// Pod cam: rigidly mounted (same `rigid: true` scheme as ./hood.js/
// ./rearSide.js - see ../cameraFollow.js's updateRigid()), but anchored
// on the chariot's actual pod (driver's seat) itself - not the centre
// engine - and aimed directly at the centre engine, so it's the camera's
// actual look-at target rather than merely "wherever the pod happens to
// be facing".
//
// IMPORTANT: lib/chariot.js designates the *centre engine* body/mesh as
// this vehicle's `chassisBody`/`chassisMesh` (there's no single rigid
// "chassis" on a hover rig - every engine + the pod are independent,
// separately-tethered bodies - see createChariotVehicle()'s header
// comment). The pod in particular swings/lags on its own tether and has
// its own cosmetic facing, so a camera that merely copies the engine's
// live position/rotation (even with a static offset baked in) still
// reads as "attached to the engine", not the pod - a fixed offset can
// only reproduce the pod's *resting* position relative to the engine,
// never its actual independent motion. So this view instead sets
// `mountPoint: 'pod'`, which tells updateCamera() in ../cameraFollow.js
// to parent this view's *position* to the chariot's real, separately-
// exposed pod mesh (see lib/chariot.js's returned `podMesh` /
// app/carManager.js's getPodMesh()) rather than chassisMesh - `offset`
// below is local to that pod mesh's own live transform.
//
// The pod's own cosmetic facing (podFacingQuat, see lib/chariot.js) is
// continuously smoothed to look toward the engine formation's live
// centroid, but it's a lagging approximation, not an exact aim - so
// rather than relying on "forward from the pod" to coincide with "at the
// engines", `lookAtTarget: 'chassis'` makes this view's *gaze* target
// chassisMesh (the centre engine) directly instead, independent of the
// pod's own facing. `lookAtOffset` below is therefore local to the
// engine's transform, not the pod's.
export default {
  id: 'pod',
  label: 'Pod Cam',
  rigid: true,
  mountPoint: 'pod',
  lookAtTarget: 'chassis',
  vehicleTypes: ['hover'],
  // Slightly above the pod's own center - a seated driver's eye level,
  // not the tiny pod sphere's exact middle.
  offset: [0, 0.3, 0],
  // Just above the centre engine's own origin - a touch of headroom so
  // the shot reads as looking at the engine itself, not through its feet.
  lookAtOffset: [0, 0.1, 0],
};

