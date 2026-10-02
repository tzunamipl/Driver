// Shared geometry for every "pod racer" (Chariots of Fire) vehicle -
// imported by both the visual body builder (podRacer.js) and the hover
// physics rig (../chariot.js) so the engines/tether/pod always line up
// between what you see and what you collide with, no matter how many
// engines a given variant has.
//
// Layout: `engineCount` jet engines in a straight line across the front
// (+Z local, same "front" convention lib/car.js's wheels use), each joined
// to its immediate neighbour by a power coupling, and to the pod (driver's
// seat, trailing behind at -Z) by a tether/thread - loosely modeled on a
// Star Wars-style podracer.

export const ENGINE_RADIUS = 0.45;
export const ENGINE_LENGTH = 2.15;
// Sized for a single driver (not a multi-seat cabin) - small enough that
// the pod reads as "just a seat dangling off the tether", not another
// vehicle-sized hull.
export const POD_RADIUS = 0.22;
export const POD_LENGTH = 0.35;
// Engines sit ahead of the chassis origin, the pod trails behind it -
// mirrors lib/car.js's wheelFront/wheelBack split (positive Z = front).
export const ENGINE_Z = 1.4;
export const POD_Z = -1.3;
// Pod hangs a little lower than the engines, like it's dangling off the
// tether rather than rigidly level with them.
export const POD_Y = -0.2;
// Total side-to-side spread of the engine row (outermost engine centers
// are ENGINE_SPREAD apart) - wide enough that the bigger ENGINE_RADIUS
// above still leaves a gap between neighbouring engines instead of
// overlapping.
export const ENGINE_SPREAD = 4.0;

/**
 * Local (x, y, z) offsets for each engine, evenly spread across
 * ENGINE_SPREAD and centered on x=0 - works for any engineCount >= 1
 * (a single engine sits dead-center).
 */
export function engineLocalOffsets(engineCount) {
  const offsets = [];
  for (let i = 0; i < engineCount; i++) {
    const t = engineCount === 1 ? 0 : i / (engineCount - 1) - 0.5;
    offsets.push({ x: t * ENGINE_SPREAD, y: 0, z: ENGINE_Z });
  }
  return offsets;
}

export const POD_LOCAL_OFFSET = { x: 0, y: POD_Y, z: POD_Z };
