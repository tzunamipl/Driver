// Filled-polygon overlay (waterAreas.js, builtUpAreas.js, landcoverAreas.js) on top of tiles/vectorTileLayer.js.
// Polygons are bucketed by outer-ring centroid like buildings.js, so a
// polygon larger than a tile renders in its centroid's tile and pops as a
// whole - acceptable for a debug overlay. classifyAt() instead searches the
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
 * @param {(props: object) => ({key: string, color: number} | null)} options.classify
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
        if (lat < entry.minLat || lat > entry.maxLat || lon < entry.minLon || lon > entry.maxLon) continue;
        if (!pointInLatLonRing(lat, lon, entry.outer)) continue;
        if (entry.holes.some((hole) => pointInLatLonRing(lat, lon, hole))) continue;
        return entry;
      }
      return null;
    }
  };
}
