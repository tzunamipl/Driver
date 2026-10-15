// Line overlay (streets.js, rivers.js) on top of tiles/vectorTileLayer.js.
// Segments are split into SEGMENT_MAX_METERS pieces and bucketed by midpoint,
// so long roads/rivers stream tile-by-tile and hug the ground between vertices.

import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, DoubleSide } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { latLonToLocal, localToLatLon } from './geo.js';
import { VectorTileLayer } from './tiles/vectorTileLayer.js';

const SEGMENT_MAX_METERS = 4;
const METERS_PER_DEGREE = 111_320;

/**
 * Builds a manager class (call `new Cls(scene, world, originLat, originLon, terrain)`).
 *
 * @param {object} options
 * @param {number} options.tileZoom
 * @param {string} options.layerName - e.g. 'transportation', 'waterway'.
 * @param {(props: object) => ({key: string, color: number, linewidth: number} | null)} options.classify
 * @param {number} [options.lift] - metres above ground, avoids z-fighting.
 * @param {boolean} [options.flat] - draw `linewidth` as a real-metre ground-hugging stripe
 *   instead of a screen-space LineMaterial fat line. Required for containsPoint().
 * @param {boolean} [options.alwaysStream] - stream even when hidden (containsPoint used by gameplay).
 * @param {number} [options.radius] - loaded square half-size in DETAIL_ZOOM tiles (default: the HIGH block).
 */
export function createVectorLineLayer({ tileZoom, layerName, classify, lift = 0.2, flat = false, alwaysStream = false, radius }) {
  // Style key -> material, shared by every tile of this layer.
  const materials = new Map();
  function materialFor(style) {
    let mat = materials.get(style.key);
    if (!mat) {
      if (flat) {
        mat = new MeshBasicMaterial({ color: style.color, transparent: true, opacity: 0.85, side: DoubleSide });
      } else {
        mat = new LineMaterial({ color: style.color, linewidth: style.linewidth, transparent: true, opacity: 0.85 });
        mat.resolution.set(window.innerWidth, window.innerHeight);
      }
      materials.set(style.key, mat);
    }
    return mat;
  }
  window.addEventListener('resize', () => {
    for (const mat of materials.values()) {
      if (mat.resolution) mat.resolution.set(window.innerWidth, window.innerHeight);
    }
  });

  return class VectorLineLayerManager extends VectorTileLayer {
    constructor(scene, world, originLat, originLon, terrain) {
      super(scene, world, originLat, originLon, { tileZoom, layerName, classify, alwaysStream, radius, terrain });
    }

    _decodeFeature(lines, style, toLatLon, add) {
      for (const line of lines) {
        if (line.length < 2) continue;
        const points = line.map(toLatLon);
        for (let p = 0; p < points.length - 1; p++) {
          const a = points[p];
          const b = points[p + 1];
          const dLat = (b.lat - a.lat) * METERS_PER_DEGREE;
          const dLon = (b.lon - a.lon) * METERS_PER_DEGREE * Math.cos((a.lat * Math.PI) / 180);
          const pieces = Math.max(1, Math.ceil(Math.hypot(dLat, dLon) / SEGMENT_MAX_METERS));
          let prev = a;
          for (let i = 1; i <= pieces; i++) {
            const t = i / pieces;
            const next = i === pieces ? b : { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
            add((prev.lat + next.lat) / 2, (prev.lon + next.lon) / 2, { a: prev, b: next, style });
            prev = next;
          }
        }
      }
    }

    _buildItem(seg, byStyleKey) {
      const a = latLonToLocal(seg.a.lat, seg.a.lon, this.originLat, this.originLon, this.scaleLat);
      const b = latLonToLocal(seg.b.lat, seg.b.lon, this.originLat, this.originLon, this.scaleLat);
      const ay = this._groundHeightAt(a.x, a.z) + lift;
      const by = this._groundHeightAt(b.x, b.z) + lift;
      const { positions } = this._bucket(byStyleKey, seg.style, () => ({ positions: [] }));
      if (!flat) {
        positions.push(a.x, ay, a.z, b.x, by, b.z);
        return;
      }
      // Quad offset sideways in XZ only, so the stripe lies on the ground.
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      const nx = len > 1e-6 ? -dz / len : 1;
      const nz = len > 1e-6 ? dx / len : 0;
      const hw = seg.style.linewidth / 2;
      const ox = nx * hw;
      const oz = nz * hw;
      positions.push(
        a.x - ox, ay, a.z - oz,
        a.x + ox, ay, a.z + oz,
        b.x + ox, by, b.z + oz,
        a.x - ox, ay, a.z - oz,
        b.x + ox, by, b.z + oz,
        b.x - ox, by, b.z - oz,
      );
    }

    _shiftBucket({ positions }, dx, dz) {
      for (let i = 0; i < positions.length; i += 3) {
        positions[i] -= dx;
        positions[i + 2] -= dz;
      }
    }

    _makeMesh(bucket) {
      if (flat) {
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute(bucket.positions, 3));
        return new Mesh(geometry, materialFor(bucket.style));
      }
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(bucket.positions);
      return new LineSegments2(geometry, materialFor(bucket.style));
    }

    /**
     * True if world (x, z) lies within half a stripe width of any fetched
     * segment (independent of mesh build/visibility). Used for surface
     * classification (terrainSurface.js) and suspensionHud. Flat layers only.
     */
    containsPoint(x, z) {
      if (!flat) return false;
      const { lat, lon } = localToLatLon(x, z, this.originLat, this.originLon, this.scaleLat);
      for (const seg of this._itemsNear(lat, lon)) {
        const a = latLonToLocal(seg.a.lat, seg.a.lon, this.originLat, this.originLon, this.scaleLat);
        const b = latLonToLocal(seg.b.lat, seg.b.lon, this.originLat, this.originLon, this.scaleLat);
        const abx = b.x - a.x;
        const abz = b.z - a.z;
        const lenSq = abx * abx + abz * abz;
        const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / lenSq)) : 0;
        if (Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t)) <= seg.style.linewidth / 2) return true;
      }
      return false;
    }
  };
}
