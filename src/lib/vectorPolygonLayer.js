// Filled-polygon overlay (waterAreas.js, builtUpAreas.js, landcoverAreas.js) on top of tiles/vectorTileLayer.js.
// Polygons are bucketed by outer-ring centroid like buildings.js, so a
// polygon larger than a tile renders in its centroid's tile and pops as a
// whole - acceptable for a debug overlay. Each polygon is cut into a fine
// grid and draped on the rendered ground. classifyAt() instead searches the
// whole source vector tile, so large lakes are found anywhere on them.
// Data always streams because classifyAt() drives gameplay (splash, tyre
// grip, built-up zone).

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { latLonToLocal, localToLatLon } from './geo.js';
import { VectorTileLayer } from './tiles/vectorTileLayer.js';

const MIN_RING_POINTS = 3;
const MAX_POLYGON_SPAN_METERS = 2000; // larger = bad data at this scale
const METERS_PER_DEGREE = 111_320;
const DRAPE_CELL_M = 6; // drape grid, finer than detail terrain cells (~13 m) so the sheet follows the ground
// Vertices slide this far toward the camera (same pixel, nearer depth), hiding the drape's error vs the terrain triangles.
const DRAPE_VIEW_BIAS_M = 0.6;
const DRAPE_VIEW_BIAS_PER_M = 0.002; // extra bias per metre of distance, for depth precision far off

/** Sutherland-Hodgman: the part of convex `poly` ([x, z] points) where sign * (p[axis] - value) >= 0. */
function clipHalfPlane(poly, axis, value, sign) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = (a[axis] - value) * sign;
    const db = (b[axis] - value) * sign;
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Calls emit(piece) for each part of triangle `tri` inside one DRAPE_CELL_M grid cell. */
function forEachGridPiece(tri, emit) {
  const cell = DRAPE_CELL_M;
  const i0 = Math.floor(Math.min(tri[0][0], tri[1][0], tri[2][0]) / cell);
  const i1 = Math.floor(Math.max(tri[0][0], tri[1][0], tri[2][0]) / cell);
  for (let i = i0; i <= i1; i++) {
    const strip = clipHalfPlane(clipHalfPlane(tri, 0, i * cell, 1), 0, (i + 1) * cell, -1);
    if (strip.length < 3) continue;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of strip) {
      minZ = Math.min(minZ, p[1]);
      maxZ = Math.max(maxZ, p[1]);
    }
    for (let j = Math.floor(minZ / cell); j <= Math.floor(maxZ / cell); j++) {
      const piece = clipHalfPlane(clipHalfPlane(strip, 1, j * cell, 1), 1, (j + 1) * cell, -1);
      if (piece.length >= 3) emit(piece);
    }
  }
}

/**
 * Ground height at (x, z) bilinear from grid nodes sampled once each, so
 * pieces sharing an edge agree on its heights (no cracks).
 */
function createDrapeHeights(minX, minZ, maxX, maxZ, groundAt) {
  const cell = DRAPE_CELL_M;
  const i0 = Math.floor(minX / cell);
  const j0 = Math.floor(minZ / cell);
  const cols = Math.floor(maxX / cell) - i0 + 2;
  const rows = Math.floor(maxZ / cell) - j0 + 2;
  const nodes = new Float32Array(cols * rows).fill(NaN);
  const node = (i, j) => {
    const k = (j - j0) * cols + (i - i0);
    if (Number.isNaN(nodes[k])) nodes[k] = groundAt(i * cell, j * cell);
    return nodes[k];
  };
  return (x, z) => {
    const fx = x / cell;
    const fz = z / cell;
    const i = Math.min(Math.max(Math.floor(fx), i0), i0 + cols - 2);
    const j = Math.min(Math.max(Math.floor(fz), j0), j0 + rows - 2);
    const u = fx - i;
    const v = fz - j;
    const top = node(i, j) * (1 - u) + node(i + 1, j) * u;
    const bottom = node(i, j + 1) * (1 - u) + node(i + 1, j + 1) * u;
    return top * (1 - v) + bottom * v;
  };
}

/** Moves each vertex DRAPE_VIEW_BIAS_M (+ distance share) along its view ray toward the camera. */
function applyViewBias(shader) {
  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    `#include <project_vertex>
    float drapeDist = length(mvPosition.xyz);
    mvPosition.xyz *= max(1.0 - (${DRAPE_VIEW_BIAS_M.toFixed(3)} + ${DRAPE_VIEW_BIAS_PER_M.toFixed(4)} * drapeDist) / max(drapeDist, 1e-3), 0.5);
    gl_Position = projectionMatrix * mvPosition;`,
  );
}

/** Ray-casting point-in-polygon in lat/lon space (fine at few-km scale). */
function pointInLatLonRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    const intersects = pi.lat > lat !== pj.lat > lat && lon < ((pj.lon - pi.lon) * (lat - pi.lat)) / (pj.lat - pi.lat) + pi.lon;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Per edge i -> i+1: true if it runs along the tile's clip border (both ends
 * past the same side), i.e. not a real shoreline.
 */
function clipEdgeFlags(ring, extent) {
  const side = (p) => (p.x <= 0 ? 1 : 0) | (p.x >= extent ? 2 : 0) | (p.y <= 0 ? 4 : 0) | (p.y >= extent ? 8 : 0);
  return ring.map((p, i) => (side(p) & side(ring[(i + 1) % ring.length])) !== 0);
}

/** Metres from (lat, lon) to the nearest non-clip edge of `ring` (Infinity if none). */
function distanceToRingEdges(lat, lon, ring, clipFlags) {
  const mPerLon = METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    if (clipFlags[i]) continue;
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const ax = (a.lon - lon) * mPerLon;
    const az = (a.lat - lat) * METERS_PER_DEGREE;
    const abx = (b.lon - a.lon) * mPerLon;
    const abz = (b.lat - a.lat) * METERS_PER_DEGREE;
    const lenSq = abx * abx + abz * abz;
    const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, -(ax * abx + az * abz) / lenSq)) : 0;
    best = Math.min(best, Math.hypot(ax + abx * t, az + abz * t));
  }
  return best;
}

/** Shoelace signed area in tile-pixel coords (only the sign is used). */
function signedArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area;
}

/**
 * Groups MVT rings into polygons: the first ring's winding marks exteriors;
 * same-sign rings start a new polygon, opposite-sign rings are holes.
 */
function classifyRings(rings) {
  const polygons = []; // [{ outer, holes: [] }]
  let outerSign = null;
  let current = null;
  for (const ring of rings) {
    if (ring.length < MIN_RING_POINTS) continue;
    const area = signedArea(ring);
    if (area === 0) continue;
    const sign = area > 0 ? 1 : -1;
    if (outerSign === null || sign === outerSign) {
      outerSign = sign;
      current = { outer: ring, holes: [] };
      polygons.push(current);
    } else if (current) {
      current.holes.push(ring);
    }
  }
  return polygons;
}

/**
 * Builds a manager class (call `new Cls(scene, world, originLat, originLon, terrain)`).
 *
 * @param {object} options
 * @param {number} options.tileZoom
 * @param {string} options.layerName - e.g. 'water'.
 * @param {(props: object) => ({key: string, color: number, debugOnly?: boolean, label?: string} | null)} options.classify -
 *   `debugOnly` polygons are drawn but ignored by classifyAt() / shoreDistanceAt() / isNear();
 *   `label` (default `key`) is what labelsAt() reports.
 * @param {number} [options.lift] - metres above ground, avoids z-fighting.
 * @param {number} [options.opacity]
 * @param {number} [options.radius] - loaded square half-size in DETAIL_ZOOM tiles (default: the HIGH block).
 */
export function createVectorPolygonLayer({ tileZoom, layerName, classify, lift = 0.3, opacity = 0.55, radius }) {
  const materials = new Map();
  function materialFor(style) {
    let mat = materials.get(style.key);
    if (!mat) {
      // DoubleSide: OSM winding isn't consistent, so either face may be up.
      mat = new THREE.MeshBasicMaterial({ color: style.color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
      mat.onBeforeCompile = applyViewBias;
      materials.set(style.key, mat);
    }
    return mat;
  }

  return class VectorPolygonLayerManager extends VectorTileLayer {
    constructor(scene, world, originLat, originLon, terrain) {
      super(scene, world, originLat, originLon, { tileZoom, layerName, classify, alwaysStream: true, radius, terrain });
    }

    _decodeFeature(rings, style, toLatLon, add, extent) {
      for (const { outer, holes } of classifyRings(rings)) {
        const outerLatLon = outer.map(toLatLon);
        let sumLat = 0;
        let sumLon = 0;
        let minLat = Infinity;
        let maxLat = -Infinity;
        let minLon = Infinity;
        let maxLon = -Infinity;
        for (const p of outerLatLon) {
          sumLat += p.lat;
          sumLon += p.lon;
          minLat = Math.min(minLat, p.lat);
          maxLat = Math.max(maxLat, p.lat);
          minLon = Math.min(minLon, p.lon);
          maxLon = Math.max(maxLon, p.lon);
        }
        add(sumLat / outerLatLon.length, sumLon / outerLatLon.length, {
          outer: outerLatLon,
          holes: holes.map((h) => h.map(toLatLon)),
          outerClip: clipEdgeFlags(outer, extent),
          holesClip: holes.map((h) => clipEdgeFlags(h, extent)),
          style,
          minLat,
          maxLat,
          minLon,
          maxLon,
        });
      }
    }

    _buildItem(entry, byStyleKey) {
      const toLocal = (p) => latLonToLocal(p.lat, p.lon, this.originLat, this.originLon, this.scaleLat);
      const outerPts = entry.outer.map(toLocal);
      if (outerPts.length < MIN_RING_POINTS) return;

      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const p of outerPts) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
      if (maxX - minX > MAX_POLYGON_SPAN_METERS || maxZ - minZ > MAX_POLYGON_SPAN_METERS) return;

      // Shape in (x, -z): (x, -y) of its triangles maps back to world (x, z).
      const shape = new THREE.Shape();
      outerPts.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, -p.z) : shape.lineTo(p.x, -p.z)));
      for (const hole of entry.holes) {
        const holePts = hole.map(toLocal);
        if (holePts.length < MIN_RING_POINTS) continue;
        const path = new THREE.Path();
        holePts.forEach((p, i) => (i === 0 ? path.moveTo(p.x, -p.z) : path.lineTo(p.x, -p.z)));
        shape.holes.push(path);
      }

      // Triangulate flat, then cut into grid cells and drape each vertex on the ground.
      const flat = new THREE.ShapeGeometry(shape);
      const flatPos = flat.getAttribute('position').array;
      const index = flat.getIndex()?.array;
      const heightAt = createDrapeHeights(minX, minZ, maxX, maxZ, (x, z) => this._groundHeightAt(x, z));
      const positions = [];
      const pushVertex = (p) => positions.push(p[0], heightAt(p[0], p[1]) + lift, p[1]);
      const corner = (k) => [flatPos[k * 3], -flatPos[k * 3 + 1]];
      const triCount = index ? index.length / 3 : flatPos.length / 9;
      for (let t = 0; t < triCount; t++) {
        const tri = index ? [corner(index[t * 3]), corner(index[t * 3 + 1]), corner(index[t * 3 + 2])] : [corner(t * 3), corner(t * 3 + 1), corner(t * 3 + 2)];
        forEachGridPiece(tri, (piece) => {
          for (let k = 1; k < piece.length - 1; k++) {
            pushVertex(piece[0]);
            pushVertex(piece[k]);
            pushVertex(piece[k + 1]);
          }
        });
      }
      flat.dispose();
      if (!positions.length) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      this._bucket(byStyleKey, entry.style, () => ({ geometries: [] })).geometries.push(geometry);
    }

    _shiftBucket({ geometries }, dx, dz) {
      for (const g of geometries) g.translate(-dx, 0, -dz);
    }

    _makeMesh({ geometries, style }) {
      if (!geometries.length) return null;
      const merged = geometries.length > 1 ? mergeGeometries(geometries, false) : geometries[0];
      if (geometries.length > 1) for (const g of geometries) g.dispose();
      return merged ? new THREE.Mesh(merged, materialFor(style)) : null;
    }

    /** Nearest point where `raycaster` hits the shown overlay, or null (hidden / missed). */
    raycastOverlay(raycaster) {
      if (!this._visible) return null;
      const meshes = [];
      for (const chunk of this.chunks.values()) meshes.push(...chunk.meshes);
      return raycaster.intersectObjects(meshes, false)[0]?.point ?? null;
    }

    /** Labels of every fetched polygon (debug-only ones too) containing world (x, z), deduplicated. */
    labelsAt(x, z) {
      const { lat, lon } = localToLatLon(x, z, this.originLat, this.originLon, this.scaleLat);
      const labels = new Set();
      for (const entry of this._itemsInSourceTile(lat, lon)) {
        if (lat < entry.minLat || lat > entry.maxLat || lon < entry.minLon || lon > entry.maxLon) continue;
        if (!pointInLatLonRing(lat, lon, entry.outer)) continue;
        if (entry.holes.some((hole) => pointInLatLonRing(lat, lon, hole))) continue;
        labels.add(entry.style.label ?? entry.style.key);
      }
      return [...labels];
    }

    /**
     * Style key (e.g. 'water') of the fetched polygon containing world (x, z),
     * or null. Independent of mesh build/visibility.
     */
    classifyAt(x, z) {
      const { lat, lon } = localToLatLon(x, z, this.originLat, this.originLon, this.scaleLat);
      return this._entryAt(lat, lon)?.style.key ?? null;
    }

    /**
     * Metres from world (x, z) to the nearest real edge of the polygon
     * containing it (tile clip borders don't count), or 0 outside every polygon.
     */
    shoreDistanceAt(x, z) {
      const { lat, lon } = localToLatLon(x, z, this.originLat, this.originLon, this.scaleLat);
      const entry = this._entryAt(lat, lon);
      if (!entry) return 0;
      let best = distanceToRingEdges(lat, lon, entry.outer, entry.outerClip);
      entry.holes.forEach((hole, i) => {
        best = Math.min(best, distanceToRingEdges(lat, lon, hole, entry.holesClip[i]));
      });
      // Every edge clipped: the whole tile is water, so the shore is far off.
      return Number.isFinite(best) ? best : MAX_POLYGON_SPAN_METERS;
    }

    /** True if world (x, z) is inside a polygon or within `margin` metres of a real edge of one. */
    isNear(x, z, margin) {
      const { lat, lon } = localToLatLon(x, z, this.originLat, this.originLon, this.scaleLat);
      const dLat = margin / METERS_PER_DEGREE;
      const dLon = dLat / Math.cos((lat * Math.PI) / 180);
      for (const entry of this._itemsInSourceTile(lat, lon)) {
        if (entry.style.debugOnly) continue;
        if (lat < entry.minLat - dLat || lat > entry.maxLat + dLat || lon < entry.minLon - dLon || lon > entry.maxLon + dLon) continue;
        const inHole = entry.holes.some((hole) => pointInLatLonRing(lat, lon, hole));
        if (!inHole && pointInLatLonRing(lat, lon, entry.outer)) return true;
        if (distanceToRingEdges(lat, lon, entry.outer, entry.outerClip) < margin) return true;
        if (entry.holes.some((hole, i) => distanceToRingEdges(lat, lon, hole, entry.holesClip[i]) < margin)) return true;
      }
      return false;
    }

    _entryAt(lat, lon) {
      for (const entry of this._itemsInSourceTile(lat, lon)) {
        if (entry.style.debugOnly) continue;
        if (lat < entry.minLat || lat > entry.maxLat || lon < entry.minLon || lon > entry.maxLon) continue;
        if (!pointInLatLonRing(lat, lon, entry.outer)) continue;
        if (entry.holes.some((hole) => pointInLatLonRing(lat, lon, hole))) continue;
        return entry;
      }
      return null;
    }
  };
}
