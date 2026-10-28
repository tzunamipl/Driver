// Shared "what kind of ground is under this (x, z) point" classification -
// used by both hud/suspensionHud.js's debug terrain-type square and
// lib/wheeledVehicle.js's per-surface tyre grip (see surfaceCompounds.js),
// kept in one place so the two can't drift out of sync on e.g. which
// surface wins when a bridge's road overlaps a river below it.
//
// Priority mirrors suspensionHud.js's original convention: road is checked
// first ("on road and water" - e.g. a bridge over a river - counts as
// road), then water (polygons or narrow waterways), then landcover (forest,
// rock, ice, scrub, sand), then
// built-up landuse, else the generic/default surface. `streets`,
// `waterAreas`, `rivers`, `landcoverAreas` and `builtUpAreas` are optional (debugVisuals.js/main.js only wire them up once
// loaded) and their underlying classification methods are themselves safe
// to call before any tile data has streamed in for this spot yet (see
// their own containsPoint/classifyAt doc comments) - this degrades to the
// default surface if either/both are missing or just haven't loaded data
// here yet.
import { DEFAULT_SURFACE_KEY } from './surfaceCompounds.js';

/**
 * @param {number} x
 * @param {number} z
 * @param {{ streets?: {surfaceAt(x: number, z: number): string|null}, waterAreas?: {classifyAt(x: number, z: number): string|null}, rivers?: {containsPoint(x: number, z: number): boolean}, landcoverAreas?: {classifyAt(x: number, z: number): string|null}, builtUpAreas?: {classifyAt(x: number, z: number): string|null} }} [layers]
 * @returns {'road'|'unpaved'|'cobblestone'|'mud'|'snow'|'water'|'forest'|'rock'|'ice'|'scrub'|'sand'|'builtUp'|'normal'}
 */
export function classifySurfaceAt(x, z, { streets, waterAreas, rivers, landcoverAreas, builtUpAreas } = {}) {
  const street = streets?.surfaceAt(x, z);
  if (street) return street;
  if (waterAreas?.classifyAt(x, z) || rivers?.containsPoint(x, z)) return 'water';
  const landcover = landcoverAreas?.classifyAt(x, z);
  if (landcover) return landcover;
  if (builtUpAreas?.classifyAt(x, z)) return 'builtUp';
  return DEFAULT_SURFACE_KEY;
}
