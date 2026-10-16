// Estimated water depth: no bathymetry, so depth grows with distance from
// the shore of the water polygon (waterAreas.js) or waterway strip (rivers.js)
// under the point. A 3 m stream peaks ~0.2 m, a 12 m river ~0.7 m, lakes 2 m.
// Roads win (bridges are dry), as in terrainSurface.js.

// Depth gained per metre from shore.
const SHORE_SLOPE = 0.04;
export const MAX_WATER_DEPTH_M = 2;

/**
 * @param {number} x
 * @param {number} z
 * @param {{ streets?: {containsPoint(x: number, z: number): boolean}, waterAreas?: {shoreDistanceAt(x: number, z: number): number}, rivers?: {shoreDistanceAt(x: number, z: number): number} }} [layers]
 * @returns {number} metres of water, 0 on dry land.
 */
export function waterDepthAt(x, z, { streets, waterAreas, rivers } = {}) {
  if (streets?.containsPoint(x, z)) return 0;
  const shore = Math.max(waterAreas?.shoreDistanceAt(x, z) ?? 0, rivers?.shoreDistanceAt(x, z) ?? 0);
  return Math.min(MAX_WATER_DEPTH_M, shore * SHORE_SLOPE);
}
