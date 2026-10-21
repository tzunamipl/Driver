// Detail tile surface (runs in tileWorker.js): a square-cell grid in the
// tile's own frame (metres from its NW corner, x east, z south) with the
// road bed and forest floor (forestFloor.js) applied, plus the matching
// Heightfield samples for physics.
// Columns fit the tile width exactly; rows step by the same cell size and
// the last row is pinned to the south edge so neighbours share vertices.

import { buildGridMesh } from './surfaceGrid.js';
import { createTileHeights } from './roadBed.js';

/**
 * @returns {{ mesh: object, cols: number, rows: number,
 *   heightfield: { heights: Float32Array, cols: number, rows: number, elementSize: number },
 *   roadProfile: { original: Float32Array, adjusted: Float32Array, causes: Uint8Array, records: Array } }}
 *   `heightfield.heights` is row-major from the north edge, square, and
 *   may overshoot the east/south edge. `roadProfile.causes` = per surface
 *   vertex, why the road bed moved it (roadBed.js ROAD_BED_CAUSE, 0 = untouched);
 *   `records` = per moved vertex, what moved it (roadBed.js evaluateGrid).
 */
export function buildDetailSurface({ elev, heightOffset, widthMeters, heightMeters, cells, skirtDepth, lines, floorAt }) {
  const step = widthMeters / cells;
  const { evaluateGrid, profileLines } = createTileHeights({ elev, heightOffset, widthMeters, heightMeters, cellMeters: step, lines, floorAt });
  const lastRow = Math.ceil(heightMeters / step - 1e-6) - 1; // last whole-step row inside the tile
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
  const grid = evaluateGrid(-step, -step, ringCols, size + 2, step, gridCauses, gridRecords);
  const edge = evaluateGrid(-step, heightMeters - step, ringCols, 3, step, edgeCauses, edgeRecords);

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
    const z = onEdge ? heightMeters : r * step;
    for (let c = 0; c <= cols; c++) {
      const i = r * (cols + 1) + c;
      const m = mid * ringCols + c + 1;
      const h = src[m];
      causes[i] = srcCauses[m];
      records[i] = srcRecords[m] ?? null;
      positions[i * 3] = c * step;
      positions[i * 3 + 1] = h;
      positions[i * 3 + 2] = z;
      // Central differences: n = (-dh/dx, 1, -dh/dz).
      const nx = -(src[m + 1] - src[m - 1]) / (2 * step);
      const nz = -(src[m + ringCols] - src[m - ringCols]) / (2 * step);
      const len = Math.hypot(nx, 1, nz);
      normals[i * 3] = nx / len;
      normals[i * 3 + 1] = 1 / len;
      normals[i * 3 + 2] = nz / len;
      uvs[i * 2] = c / cols;
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
