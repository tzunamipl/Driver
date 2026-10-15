// Filled-polygon overlay (waterAreas.js) on top of tiles/vectorTileLayer.js.
// Polygons are bucketed by outer-ring centroid like buildings.js, so a
// polygon larger than a tile renders in its centroid's tile and pops as a
// whole - acceptable for a debug overlay. classifyAt() instead searches the
// whole source vector tile, so large lakes are found anywhere on them.
// Data always streams because classifyAt() drives splash.js's
// wheel-on-water check and tyre grip.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { latLonToLocal, localToLatLon } from './geo.js';
import { VectorTileLayer } from './tiles/vectorTileLayer.js';

const MIN_RING_POINTS = 3;
const MAX_POLYGON_SPAN_METERS = 2000; // larger = bad data at this scale

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
 * @param {(props: object) => ({key: string, color: number} | null)} options.classify
 * @param {number} [options.lift] - metres above ground, avoids z-fighting.
 * @param {number} [options.opacity]
 */
export function createVectorPolygonLayer({ tileZoom, layerName, classify, lift = 0.3, opacity = 0.55 }) {
  const materials = new Map();
  function materialFor(style) {
    let mat = materials.get(style.key);
    if (!mat) {
      // DoubleSide: OSM winding isn't consistent, so either face may be up.
      mat = new THREE.MeshBasicMaterial({ color: style.color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
      materials.set(style.key, mat);
    }
    return mat;
  }

  return class VectorPolygonLayerManager extends VectorTileLayer {
    constructor(scene, world, originLat, originLon, terrain) {
      super(scene, world, originLat, originLon, { tileZoom, layerName, classify, alwaysStream: true, terrain });
    }

    _decodeFeature(rings, style, toLatLon, add) {
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

      // Shape in (x, -z), then rotateX(-90deg) onto the ground - as buildings.js does.
      const shape = new THREE.Shape();
      outerPts.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, -p.z) : shape.lineTo(p.x, -p.z)));
      for (const hole of entry.holes) {
        const holePts = hole.map(toLocal);
        if (holePts.length < MIN_RING_POINTS) continue;
        const path = new THREE.Path();
        holePts.forEach((p, i) => (i === 0 ? path.moveTo(p.x, -p.z) : path.lineTo(p.x, -p.z)));
        shape.holes.push(path);
      }

      const geometry = new THREE.ShapeGeometry(shape);
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, this._groundHeightAt((minX + maxX) / 2, (minZ + maxZ) / 2) + lift, 0);
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

    /**
     * Style key (e.g. 'water') of the fetched polygon containing world (x, z),
     * or null. Independent of mesh build/visibility.
     */
    classifyAt(x, z) {
      const { lat, lon } = localToLatLon(x, z, this.originLat, this.originLon, this.scaleLat);
      for (const entry of this._itemsInSourceTile(lat, lon)) {
        if (lat < entry.minLat || lat > entry.maxLat || lon < entry.minLon || lon > entry.maxLon) continue;
        if (!pointInLatLonRing(lat, lon, entry.outer)) continue;
        if (entry.holes.some((hole) => pointInLatLonRing(lat, lon, hole))) continue;
        return entry.style.key;
      }
      return null;
    }
  };
}
