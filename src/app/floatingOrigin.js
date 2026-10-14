// Floating origin: once the car is REBASE_DISTANCE_METERS from (0, 0), the
// view frame's origin moves under it and the whole world is translated
// back, so coordinates stay small. float32 (GPU vertex maths, Trimesh
// vertices, shadow lookups) is only precise near zero: hundreds of km out
// it rounds to centimetres and the scene visibly jitters.
//
// The view frame keeps its east-west scale (see viewFrame.js), so the shift
// is an exact translation: content built before and after lines up.
// Generic part: every physics body and top-level scene object, plus the
// camera. Everything else holding world-space positions between frames
// registers a shiftOrigin(dx, dz) via `parts` (or onShift for later ones).

const REBASE_DISTANCE_METERS = 2000;

function shiftVec(v, dx, dz) {
  v.x -= dx;
  v.z -= dz;
}

export function createFloatingOrigin({ scene, world, camera, viewFrame, streamers, parts }) {
  const listeners = [...parts];

  /** Moves the origin to local (dx, dz) and translates everything by (-dx, -dz). */
  function shift(dx, dz) {
    const { lat, lon } = viewFrame.toLatLon(dx, dz);
    viewFrame.set(lat, lon, viewFrame.get().scaleLat);

    for (const body of world.bodies) {
      shiftVec(body.position, dx, dz);
      shiftVec(body.previousPosition, dx, dz);
      shiftVec(body.interpolatedPosition, dx, dz);
      shiftVec(body.initPosition, dx, dz);
      body.aabbNeedsUpdate = true;
    }
    for (const obj of scene.children) {
      shiftVec(obj.position, dx, dz);
      if (!obj.matrixAutoUpdate) obj.updateMatrix();
    }
    shiftVec(camera.position, dx, dz);

    for (const streamer of streamers) streamer?.shiftOrigin(lat, lon, dx, dz);
    for (const part of listeners) part.shiftOrigin(dx, dz);
  }

  /** Call once per frame (outside physics stepping) with the car's position. */
  function update(position) {
    if (!position || Math.hypot(position.x, position.z) < REBASE_DISTANCE_METERS) return;
    shift(position.x, position.z);
  }

  return {
    update,
    shift,
    /** Registers another { shiftOrigin(dx, dz) }. */
    onShift(part) {
      listeners.push(part);
    },
  };
}
