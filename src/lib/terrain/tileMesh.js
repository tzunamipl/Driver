import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { tileX2lon, tileY2lat, latLonToLocal } from '../geo.js';
import { sampleHeight, perimeterIndices, buildGridMesh } from './surfaceGrid.js';
import { ROAD_BED_CAUSE, ROAD_BED_CAUSE_MASK, ROAD_BED_OVERRIDE } from './roadBed.js';

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
  return { ...geometryFromGridMesh(mesh, grid, grid), anchor };
}

/** BufferGeometry + skirtless `surface` view of a buildGridMesh() result. */
export function geometryFromGridMesh(mesh, cols, rows) {
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
      positions: positions.subarray(0, surfaceCount * 3),
      normals: normals.subarray(0, surfaceCount * 3),
      indices: indices.subarray(0, surfaceIndexCount),
    },
  };
}

// Debug tile border, lifted along vertex normals to avoid z-fighting. Fat
// line (LineMaterial) because WebGL ignores `linewidth` on basic lines; it
// needs the viewport resolution.
const BORDER_LIFT = 0.15;
const WIREFRAME_LIFT = 0.1;
const LINE_COLOR = 0xffe14d;
const borderMaterial = new LineMaterial({ color: LINE_COLOR, linewidth: 3, transparent: true, opacity: 0.85 });
const wireframeMaterial = new THREE.MeshBasicMaterial({ color: LINE_COLOR, wireframe: true, transparent: true, opacity: 0.35, fog: false });
// Road profiles draw through the ground: the original terrain is mostly buried under fills.
const profileMaterial = (color) => new LineMaterial({ color, linewidth: 2, depthTest: false, transparent: true, opacity: 0.9 });
const profileOriginalMaterial = profileMaterial(0xff4040);
const profileAdjustedMaterial = profileMaterial(0x40e0ff);
const CAUSE_LIFT = 0.2;
/** Debug legend for the road profile's vertex dots, keyed like ROAD_BED_CAUSE; `override` = the ring. */
export const ROAD_BED_CAUSE_LEGEND = [
  { cause: 'top', color: '#ffffff', label: 'Road top' },
  { cause: 'fill', color: '#ff9a1f', label: 'Embankment (raised)' },
  { cause: 'cut', color: '#3d7bff', label: 'Cutting (lowered)' },
  { cause: 'bankFade', color: '#4ce04c', label: 'Bank fading out' },
  { cause: 'tailFade', color: '#e04cff', label: 'Free-end tail fade' },
  { cause: 'override', color: '#ff2a2a', label: 'Over a lower road (ring)' },
];
const causeColors = Object.fromEntries(ROAD_BED_CAUSE_LEGEND.map(({ cause, color }) => [cause, new THREE.Color(color)]));
const causeByCode = Object.fromEntries(Object.entries(ROAD_BED_CAUSE).map(([cause, code]) => [code, causeColors[cause]]));
const causeDotMaterial = new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, fog: false });
const causeRingMaterial = new THREE.PointsMaterial({ size: 11, sizeAttenuation: false, color: causeColors.override, fog: false });
const sourceMaterials = new Set(); // per inspected vertex, see buildRoadBedSources
function updateLineResolution() {
  for (const m of [borderMaterial, profileOriginalMaterial, profileAdjustedMaterial, ...sourceMaterials]) m.resolution.set(window.innerWidth, window.innerHeight);
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

/** Border loop of a tile surface. `liftScale` grows the lift for big, far tiles. */
export function buildTileBorder(surface, liftScale = 1) {
  const perimeter = perimeterIndices(surface.cols, surface.rows);
  const pairs = [];
  for (let i = 0; i < perimeter.length; i++) pairs.push(perimeter[i], perimeter[(i + 1) % perimeter.length]);
  return new LineSegments2(liftedSegments(surface, pairs, BORDER_LIFT * liftScale), borderMaterial);
}

const causeDotPosition = (surface, v) => [0, 1, 2].map((k) => surface.positions[v * 3 + k] + surface.normals[v * 3 + k] * CAUSE_LIFT);

/** Dots on the surface vertices the road bed moved, coloured by cause (ROAD_BED_CAUSE_LEGEND). */
function buildCauseDots(surface, causes) {
  const dots = [];
  const dotColors = [];
  const rings = [];
  for (let v = 0; v < causes.length; v++) {
    const color = causeByCode[causes[v] & ROAD_BED_CAUSE_MASK];
    if (!color) continue;
    const p = causeDotPosition(surface, v);
    dots.push(...p);
    dotColors.push(color.r, color.g, color.b);
    if (causes[v] & ROAD_BED_OVERRIDE) rings.push(...p);
  }
  const points = [];
  for (const [positionsOut, colors, material] of [[rings, null, causeRingMaterial], [dots, dotColors, causeDotMaterial]]) {
    if (!positionsOut.length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positionsOut, 3));
    if (colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const dotsMesh = new THREE.Points(geometry, material);
    dotsMesh.renderOrder = 10;
    points.push(dotsMesh);
  }
  return points;
}

/**
 * Debug: the moved vertex of `mesh` (its `surface` + road profile `causes`) nearest screen point
 * (sx, sy) of a `width` x `height` view; replaces `best` ({ dist } px) when nearer, with { dist, vertex }.
 */
export function pickCauseDot(mesh, surface, causes, camera, sx, sy, width, height, best) {
  const p = new THREE.Vector3();
  for (let v = 0; v < causes.length; v++) {
    if (!causes[v]) continue;
    p.fromArray(causeDotPosition(surface, v)).applyMatrix4(mesh.matrixWorld).project(camera);
    if (p.z > 1) continue; // behind the camera
    const dist = Math.hypot(((p.x + 1) / 2) * width - sx, ((1 - p.y) / 2) * height - sy);
    if (dist < best.dist) best = { dist, vertex: v };
  }
  return best;
}

/** Debug: world position of a cause dot (see pickCauseDot) into `out`. */
export function causeDotWorldPosition(mesh, surface, vertex, out) {
  return out.fromArray(causeDotPosition(surface, vertex)).applyMatrix4(mesh.matrixWorld);
}

/**
 * Debug: lines from moved vertex `vertex` to each centreline point its height blends (`record.sources`,
 * roadBed.js evaluateGrid), opacity by weight, each with a drop to the terrain under it. Free with disposeRoadBedSources.
 */
export function buildRoadBedSources(surface, vertex, { sources }, cause) {
  const color = causeByCode[cause & ROAD_BED_CAUSE_MASK];
  const from = causeDotPosition(surface, vertex);
  const group = new THREE.Group();
  let maxWeight = 0;
  for (let k = 3; k < sources.length; k += 5) maxWeight = Math.max(maxWeight, sources[k]);
  const marks = [...from];
  for (let k = 0; k < sources.length; k += 5) {
    const [x, road, z, weight, ground] = sources.slice(k, k + 5);
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions([...from, x, road, z, x, road, z, x, ground, z]);
    const opacity = 0.2 + 0.8 * (weight / maxWeight);
    const material = new LineMaterial({ color, linewidth: 2, depthTest: false, transparent: true, opacity });
    material.resolution.set(window.innerWidth, window.innerHeight);
    sourceMaterials.add(material);
    const line = new LineSegments2(geometry, material);
    line.renderOrder = 11;
    group.add(line);
    marks.push(x, road, z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(marks, 3));
  const dots = new THREE.Points(geometry, new THREE.PointsMaterial({ color, size: 10, sizeAttenuation: false, depthTest: false, fog: false }));
  dots.renderOrder = 12;
  group.add(dots);
  return group;
}

export function disposeRoadBedSources(group) {
  group.removeFromParent();
  for (const child of group.children) {
    child.geometry.dispose();
    child.material.dispose();
    sourceMaterials.delete(child.material);
  }
}

/**
 * Road centreline profiles (roadBed.js `profileLines`): original terrain in red, the road's own height in cyan;
 * plus `surface` vertices the road bed moved, as dots by cause.
 */
export function buildRoadProfileLines({ original, adjusted, causes }, surface) {
  const group = new THREE.Group();
  if (causes) group.add(...buildCauseDots(surface, causes));
  for (const [positions, material] of [[original, profileOriginalMaterial], [adjusted, profileAdjustedMaterial]]) {
    if (!positions.length) continue;
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    const line = new LineSegments2(geometry, material);
    line.renderOrder = 10;
    group.add(line);
  }
  return group;
}

/** Wireframe of the rendered tile geometry (shared, not copied; skirt included), lifted straight up. */
export function buildTileWireframe(geometry, liftScale = 1) {
  const wire = new THREE.Mesh(geometry, wireframeMaterial);
  wire.position.y = WIREFRAME_LIFT * liftScale;
  return wire;
}
