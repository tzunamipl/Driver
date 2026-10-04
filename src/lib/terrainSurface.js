// Shared "what kind of ground is under this (x, z) point" classification -
// used by both hud/suspensionHud.js's debug terrain-type square and
// lib/wheeledVehicle.js's per-surface tyre grip (see surfaceCompounds.js),
// kept in one place so the two can't drift out of sync on e.g. which
// surface wins when a bridge's road overlaps a river below it.
//
// Priority mirrors suspensionHud.js's original convention: road is checked
// first ("on road and water" - e.g. a bridge over a river - counts as
// road), then water, else the generic/default surface. Both `streets` and
// `waterAreas` are optional (debugVisuals.js/main.js only wire them up once
// loaded) and their underlying classification methods are themselves safe
// to call before any tile data has streamed in for this spot yet (see
// their own containsPoint/classifyAt doc comments) - this degrades to the
// default surface if either/both are missing or just haven't loaded data
// here yet.
import { DEFAULT_SURFACE_KEY } from './surfaceCompounds.js';

/**
 * @param {number} x
 * @param {number} z
 * @param {{ streets?: {containsPoint(x: number, z: number): boolean}, waterAreas?: {classifyAt(x: number, z: number): string|null} }} [layers]
 * @returns {'road'|'water'|'normal'}
 */
export function classifySurfaceAt(x, z, { streets, waterAreas } = {}) {
  if (streets?.containsPoint(x, z)) return 'road';
  if (waterAreas?.classifyAt(x, z)) return 'water';
  return DEFAULT_SURFACE_KEY;
}
