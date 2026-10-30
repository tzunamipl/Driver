// Detail tile surface (runs in tileWorker.js): the tile is cut into DETAIL_SPLIT x DETAIL_SPLIT
// parts, each a square-cell grid of its own resolution in the tile's frame (metres from the
// tile's NW corner, x east, z south) with the road bed and forest floor (forestFloor.js) applied,
// plus the matching Heightfield samples for physics.
// Columns fit the part width exactly; rows step by the same cell size and
// the last row is pinned to the part's south edge so neighbours share vertices.

import { buildGridMesh } from './surfaceGrid.js';
import { createTileHeights, profileRoadLines } from './roadBed.js';

export const DETAIL_SPLIT = 3; // parts across a detail tile

/** Part `index` (row-major, NW first) of a detail tile: { x0, z0, width, height } in the tile's frame. */
export function partRegion(index, widthMeters, heightMeters) {
  const width = widthMeters / DETAIL_SPLIT;
  const height = heightMeters / DETAIL_SPLIT;
  return { x0: (index % DETAIL_SPLIT) * width, z0: Math.floor(index / DETAIL_SPLIT) * height, width, height };
}

/**
 * Builds the `parts` ([{ index, cells }]) of a detail tile.
 * @returns {Array<{ index: number, x0: number, z0: number, mesh: object, cols: number, rows: number,
 *   heightfield: { heights: Float32Array, cols: number, rows: number, elementSize: number },
 *   roadProfile: { original: Float32Array, adjusted: Float32Array, causes: Uint8Array, records: Array } }>}
 *   `heightfield.heights` is row-major from the part's north edge, square, and
 *   may overshoot its east/south edge. `roadProfile.causes` = per surface
 *   vertex, why the road bed moved it (roadBed.js ROAD_BED_CAUSE, 0 = untouched);
 *   `records` = per moved vertex, what moved it (roadBed.js evaluateGrid).
 */
export function buildDetailSurface({ elev, heightOffset, widthMeters, heightMeters, parts, skirtDepth, lines, floorAt }) {
  const profiled = profileRoadLines({ elev, heightOffset, widthMeters, heightMeters, lines });
  return parts.map(({ index, cells }) => {
    const region = partRegion(index, widthMeters, heightMeters);
    const step = region.width / cells;
    const heights = createTileHeights({ elev, heightOffset, widthMeters, heightMeters, cellMeters: step, lines: profiled, floorAt, region });
    return { index, x0: region.x0, z0: region.z0, ...buildPart(heights, region, cells, widthMeters, heightMeters, skirtDepth) };
  });
}

function buildPart({ evaluateGrid, profileLines }, { x0, z0, height: partHeight }, cells, widthMeters, heightMeters, skirtDepth) {
  const step = (widthMeters / DETAIL_SPLIT) / cells;
  const lastRow = Math.ceil(partHeight / step - 1e-6) - 1; // last whole-step row inside the part
  const cols = cells; // cells across
  const rows = lastRow + 1; // cells down (incl. the partial one at the south edge)
  // cannon's Heightfield raycast assumes a square field, so physics gets
  // size x size nodes, padded with real heights past the east/south edge.
  const size = Math.max(cols + 1, lastRow + 2);
  const ringCols = size + 2; // plus a ring for normals

  // Step grid from (-1, -1) covering render rows 0..lastRow and the physics square; the south edge row separately.
  const gridCauses = new Uint8Array(ringCols * (size + 2));
  const edgeCauses = new Uint8Array(ringCols * 3);
  const gridRecords = new Array(gridCauses.length);
  const edgeRecords = new Array(edgeCauses.length);
  const grid = evaluateGrid(x0 - step, z0 - step, ringCols, size + 2, step, gridCauses, gridRecords);
  const edge = evaluateGrid(x0 - step, z0 + partHeight - step, ringCols, 3, step, edgeCauses, edgeRecords);

  const vertexCount = (cols + 1) * (rows + 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const causes = new Uint8Array(vertexCount);
  const records = new Array(vertexCount).fill(null);
  for (let r = 0; r <= rows; r++) {
    const onEdge = r > lastRow;
    const src = onEdge ? edge : grid;
    const srcCauses = onEdge ? edgeCauses : gridCauses;
    const srcRecords = onEdge ? edgeRecords : gridRecords;
    const mid = onEdge ? 1 : r + 1; // this row within `src`
    const z = z0 + (onEdge ? partHeight : r * step);
    for (let c = 0; c <= cols; c++) {
      const i = r * (cols + 1) + c;
      const m = mid * ringCols + c + 1;
      const x = x0 + c * step;
      const h = src[m];
      causes[i] = srcCauses[m];
      records[i] = srcRecords[m] ?? null;
      positions[i * 3] = x;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = z;
      // Central differences: n = (-dh/dx, 1, -dh/dz).
      const nx = -(src[m + 1] - src[m - 1]) / (2 * step);
      const nz = -(src[m + ringCols] - src[m - ringCols]) / (2 * step);
      const len = Math.hypot(nx, 1, nz);
      normals[i * 3] = nx / len;
      normals[i * 3 + 1] = 1 / len;
      normals[i * 3 + 2] = nz / len;
      // The tile's one texture spans every part.
      uvs[i * 2] = x / widthMeters;
      uvs[i * 2 + 1] = z / heightMeters; // ImageBitmap textures upload unflipped: v=0 is the north row
    }
  }

  const heights = new Float32Array(size * size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) heights[r * size + c] = grid[(r + 1) * ringCols + c + 1];
  }

  return {
    mesh: buildGridMesh({ positions, normals, uvs, cols, rows, skirtDepth, nwse: true }),
    cols,
    rows,
    heightfield: { heights, cols: size, rows: size, elementSize: step },
    roadProfile: { ...profileLines(), causes, records },
  };
}
