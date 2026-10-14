// Three-free grid helpers shared by tileMesh.js (main thread) and
// detailSurface.js (tile worker): height sampling and grid triangulation.

/**
 * Elevation at tile-relative (u, v): bilinear between pixel centres. With a
 * neighbour `border` (see tileWorker.js) both tiles read the same pixels
 * across their shared edge, so it matches exactly; without one the outer
 * half pixel is extrapolated (exact only on even slopes).
 */
export function sampleHeight({ heights, width, height, border = 0 }, u, v) {
  const fx = u * (width - 2 * border) - 0.5 + border;
  const fy = v * (height - 2 * border) - 0.5 + border;
  const x0 = Math.min(width - 2, Math.max(0, Math.floor(fx)));
  const y0 = Math.min(height - 2, Math.max(0, Math.floor(fy)));
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * width + x0;
  const top = heights[i] + (heights[i + 1] - heights[i]) * tx;
  const bottom = heights[i + width] + (heights[i + width + 1] - heights[i + width]) * tx;
  return top + (bottom - top) * ty;
}

/** Perimeter vertex indices of a (cols+1) x (rows+1) vertex grid, clockwise seen from above (N edge W->E first). */
export function perimeterIndices(cols, rows) {
  const row = cols + 1;
  const out = [];
  for (let ix = 0; ix <= cols; ix++) out.push(ix);
  for (let iy = 1; iy <= rows; iy++) out.push(iy * row + cols);
  for (let ix = cols - 1; ix >= 0; ix--) out.push(rows * row + ix);
  for (let iy = rows - 1; iy >= 1; iy--) out.push(iy * row);
  return out;
}

/**
 * Appends a skirt hanging `skirtDepth` below the grid's edge (hides cracks
 * against coarser/finer neighbours) and triangulates both. `surface*` arrays
 * hold the (cols+1) x (rows+1) grid, rows north to south. `nwse` picks the
 * cell diagonal (NW-SE matches cannon's Heightfield; default NE-SW).
 */
export function buildGridMesh({ positions: surfacePositions, normals: surfaceNormals, uvs: surfaceUvs, cols, rows, skirtDepth, nwse = false }) {
  const row = cols + 1;
  const surfaceCount = row * (rows + 1);
  const perimeter = perimeterIndices(cols, rows);
  const total = surfaceCount + perimeter.length;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  positions.set(surfacePositions);
  normals.set(surfaceNormals);
  uvs.set(surfaceUvs);

  // Skirt vertices: copies of the perimeter, dropped straight down.
  for (let i = 0; i < perimeter.length; i++) {
    const src = perimeter[i];
    const dst = surfaceCount + i;
    positions[dst * 3] = positions[src * 3];
    positions[dst * 3 + 1] = positions[src * 3 + 1] - skirtDepth;
    positions[dst * 3 + 2] = positions[src * 3 + 2];
    normals.copyWithin(dst * 3, src * 3, src * 3 + 3);
    uvs.copyWithin(dst * 2, src * 2, src * 2 + 2);
  }

  const surfaceIndexCount = cols * rows * 6;
  const indices = new Uint32Array(surfaceIndexCount + perimeter.length * 6);
  let k = 0;
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const a = iy * row + ix; // NW
      const b = a + row; // SW
      const c = b + 1; // SE
      const d = a + 1; // NE
      // Counter-clockwise seen from above (front face up).
      if (nwse) {
        indices[k++] = a; indices[k++] = b; indices[k++] = c;
        indices[k++] = a; indices[k++] = c; indices[k++] = d;
      } else {
        indices[k++] = a; indices[k++] = b; indices[k++] = d;
        indices[k++] = b; indices[k++] = c; indices[k++] = d;
      }
    }
  }
  for (let i = 0; i < perimeter.length; i++) {
    const j = (i + 1) % perimeter.length;
    const a = perimeter[i];
    const b = perimeter[j];
    const sa = surfaceCount + i;
    const sb = surfaceCount + j;
    // Facing outward (perimeter runs clockwise seen from above).
    indices[k++] = a; indices[k++] = b; indices[k++] = sa;
    indices[k++] = b; indices[k++] = sb; indices[k++] = sa;
  }

  return { positions, normals, uvs, indices, surfaceCount, surfaceIndexCount };
}
