import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { tileX2lon, tileY2lat, latLonToLocal } from '../geo.js';
import { sampleHeight, perimeterIndices, buildGridMesh } from './surfaceGrid.js';

/**
 * Displaced square grid for tile (z, x, y), plus a skirt (see buildGridMesh).
 * Vertices are relative to `anchor` (the tile centre, local metres at
 * y=0): small float32 values stay precise however far the tile is from the
 * origin. `surface` excludes the skirt (for debug lines).
 * Normals come from the heightfield, not the triangles, so they match
 * across tile edges. `elev` null = flat.
 */
export function buildTileGeometry({ z, x, y, grid, elev, heightOffset, originLat, originLon, scaleLat, skirtDepth }) {
  const row = grid + 1;
  const count = row * row;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);

  const point = (u, v, out) => {
    const lon = tileX2lon(x + u, z);
    const lat = tileY2lat(y + v, z);
    const local = latLonToLocal(lat, lon, originLat, originLon, scaleLat);
    out.x = local.x;
    out.y = elev ? sampleHeight(elev, u, v) - heightOffset : 0;
    out.z = local.z;
    return out;
  };
  const p = {};
  const pu0 = {};
  const pu1 = {};
  const pv0 = {};
  const pv1 = {};
  const e = 1 / grid; // gradient over one cell, matching the mesh's own scale
  const anchor = point(0.5, 0.5, {});
  anchor.y = 0;

  for (let iy = 0; iy <= grid; iy++) {
    for (let ix = 0; ix <= grid; ix++) {
      const idx = iy * row + ix;
      const u = ix / grid;
      const v = iy / grid;
      point(u, v, p);
      positions[idx * 3] = p.x - anchor.x;
      positions[idx * 3 + 1] = p.y;
      positions[idx * 3 + 2] = p.z - anchor.z;
      uvs[idx * 2] = u;
      uvs[idx * 2 + 1] = v; // ImageBitmap textures upload unflipped: v=0 is the north row

      point(u - e, v, pu0);
      point(u + e, v, pu1);
      point(u, v - e, pv0);
      point(u, v + e, pv1);
      // n = dV x dU (dU points east, dV south; gives +y on flat ground).
      const ax = pu1.x - pu0.x, ay = pu1.y - pu0.y, az = pu1.z - pu0.z;
      const bx = pv1.x - pv0.x, by = pv1.y - pv0.y, bz = pv1.z - pv0.z;
      let nx = by * az - bz * ay;
      let ny = bz * ax - bx * az;
      let nz = bx * ay - by * ax;
      const len = Math.hypot(nx, ny, nz) || 1;
      normals[idx * 3] = nx / len;
      normals[idx * 3 + 1] = ny / len;
      normals[idx * 3 + 2] = nz / len;
    }
  }

  const mesh = buildGridMesh({ positions, normals, uvs, cols: grid, rows: grid, skirtDepth });
  return { ...geometryFromGridMesh(mesh, grid, grid, { lineStride: 1, nwse: false }), anchor };
}

/** BufferGeometry + skirtless `surface` view of a buildGridMesh() result. */
export function geometryFromGridMesh(mesh, cols, rows, { lineStride, nwse }) {
  const { positions, normals, uvs, indices, surfaceCount, surfaceIndexCount } = mesh;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return {
    geometry,
    surface: {
      cols,
      rows,
      lineStride,
      nwse,
      positions: positions.subarray(0, surfaceCount * 3),
      normals: normals.subarray(0, surfaceCount * 3),
      indices: indices.subarray(0, surfaceIndexCount),
    },
  };
}

// Debug tile lines, lifted along vertex normals to avoid z-fighting; the
// border sits above the grid. Fat lines (LineMaterial) because WebGL
// ignores `linewidth` on basic lines; they need the viewport resolution.
const BORDER_LIFT = 0.15;
const GRID_LIFT = 0.1;
const LINE_COLOR = 0xffe14d;
const borderMaterial = new LineMaterial({ color: LINE_COLOR, linewidth: 3, transparent: true, opacity: 0.85 });
const gridMaterial = new LineMaterial({ color: LINE_COLOR, linewidth: 1.25, transparent: true, opacity: 0.25 });
function updateLineResolution() {
  borderMaterial.resolution.set(window.innerWidth, window.innerHeight);
  gridMaterial.resolution.set(window.innerWidth, window.innerHeight);
}
updateLineResolution();
window.addEventListener('resize', updateLineResolution);

function liftedSegments(surface, vertexPairs, lift) {
  const { positions, normals } = surface;
  const out = new Float32Array(vertexPairs.length * 3);
  for (let i = 0; i < vertexPairs.length; i++) {
    const v = vertexPairs[i] * 3;
    out[i * 3] = positions[v] + normals[v] * lift;
    out[i * 3 + 1] = positions[v + 1] + normals[v + 1] * lift;
    out[i * 3 + 2] = positions[v + 2] + normals[v + 2] * lift;
  }
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(out);
  return geometry;
}

/** Border loop + every `lineStride`-th grid line of a tile surface (and cell diagonals at stride 1). `liftScale` grows the lift for big, far tiles. */
export function buildTileDebugLines(surface, liftScale = 1) {
  const { cols, rows, lineStride: stride, nwse } = surface;
  const row = cols + 1;
  const perimeter = perimeterIndices(cols, rows);
  const borderPairs = [];
  for (let i = 0; i < perimeter.length; i++) borderPairs.push(perimeter[i], perimeter[(i + 1) % perimeter.length]);

  const gridPairs = [];
  for (let iy = 0; iy <= rows; iy++) {
    for (let ix = 0; ix <= cols; ix++) {
      const a = iy * row + ix;
      if (ix < cols && iy % stride === 0) gridPairs.push(a, a + 1);
      if (iy < rows && ix % stride === 0) gridPairs.push(a, a + row);
      if (stride === 1 && ix < cols && iy < rows) {
        if (nwse) gridPairs.push(a, a + row + 1);
        else gridPairs.push(a + row, a + 1);
      }
    }
  }

  return {
    border: new LineSegments2(liftedSegments(surface, borderPairs, BORDER_LIFT * liftScale), borderMaterial),
    grid: new LineSegments2(liftedSegments(surface, gridPairs, GRID_LIFT * liftScale), gridMaterial),
  };
}
