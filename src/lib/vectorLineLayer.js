// Line overlay (streets.js, rivers.js) on top of tiles/vectorTileLayer.js.
// Segments are split into SEGMENT_MAX_METERS pieces and bucketed by midpoint,
// so long roads/rivers stream tile-by-tile and hug the ground between vertices.

import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, DoubleSide } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { latLonToLocal, localToLatLon, lon2tileX, lat2tileY, tileSizeMeters } from './geo.js';
import { VectorTileLayer, tileKey } from './tiles/vectorTileLayer.js';
import { DETAIL_ZOOM } from './terrain.js';

const SEGMENT_MAX_METERS = 4;
const METERS_PER_DEGREE = 111_320;
// Point queries look into a neighbouring bucket tile only this close to its edge:
// half the widest stripe (motorway 23 m) plus half a segment, with slack.
const NEIGHBOUR_REACH_M = 20;

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

    // Items also carry `dist` (metres along the line at `a`), `len`, `buffer`
    // (midpoint in the source tile's overlap with its neighbours) and `line`
    // (all of its line's items, in order), for roadside.js kinds.
    _decodeFeature(lines, style, toLatLon, add, extent) {
      const inTile = (x, y) => x >= 0 && x < extent && y >= 0 && y < extent;
      for (const line of lines) {
        if (line.length < 2) continue;
        const points = line.map(toLatLon);
        const items = [];
        let dist = 0;
        for (let p = 0; p < points.length - 1; p++) {
          const a = points[p];
          const b = points[p + 1];
          const dLat = (b.lat - a.lat) * METERS_PER_DEGREE;
          const dLon = (b.lon - a.lon) * METERS_PER_DEGREE * Math.cos((a.lat * Math.PI) / 180);
          const length = Math.hypot(dLat, dLon);
          const pieces = Math.max(1, Math.ceil(length / SEGMENT_MAX_METERS));
          const len = length / pieces;
          let prev = a;
          for (let i = 1; i <= pieces; i++) {
            const t = i / pieces;
            const next = i === pieces ? b : { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
            const tm = (i - 0.5) / pieces;
            const mx = line[p].x + (line[p + 1].x - line[p].x) * tm;
            const my = line[p].y + (line[p + 1].y - line[p].y) * tm;
            const item = { a: prev, b: next, style, dist, len, buffer: !inTile(mx, my), line: items };
            items.push(item);
            add((prev.lat + next.lat) / 2, (prev.lon + next.lon) / 2, item);
            dist += len;
            prev = next;
          }
        }
      }
    }

    /** Fetched segments bucketed in DETAIL_ZOOM tiles overlapping the square of half-size `radius` around world (x, z). */
    *itemsWithin(x, z, radius) {
      const sw = localToLatLon(x - radius, z + radius, this.originLat, this.originLon, this.scaleLat);
      const ne = localToLatLon(x + radius, z - radius, this.originLat, this.originLon, this.scaleLat);
      const minTx = Math.floor(lon2tileX(sw.lon, DETAIL_ZOOM));
      const maxTx = Math.floor(lon2tileX(ne.lon, DETAIL_ZOOM));
      const minTy = Math.floor(lat2tileY(ne.lat, DETAIL_ZOOM));
      const maxTy = Math.floor(lat2tileY(sw.lat, DETAIL_ZOOM));
      for (let tx = minTx; tx <= maxTx; tx++) {
        for (let ty = minTy; ty <= maxTy; ty++) {
          const list = this._itemsByTile.get(tileKey(tx, ty));
          if (list) yield* list;
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
      return this._insideMargin(x, z, true) >= 0;
    }

    /** Styles of the fetched segments whose stripe covers world (x, z) (may repeat). Flat layers only. */
    *stylesAt(x, z) {
      if (!flat) return;
      for (const list of this._listsNear(x, z)) {
        for (const seg of list) if (this._segmentMargin(seg, x, z) >= 0) yield seg.style;
      }
    }

    /** Metres from world (x, z) to the nearest strip edge, inside the widest strip covering it; 0 outside. */
    shoreDistanceAt(x, z) {
      return Math.max(0, this._insideMargin(x, z, false));
    }

    /** Largest (half width - distance to centreline) over nearby segments; -Infinity if none. */
    _insideMargin(x, z, firstHit) {
      if (!flat) return -Infinity;
      let best = -Infinity;
      for (const list of this._listsNear(x, z)) {
        for (const seg of list) {
          const margin = this._segmentMargin(seg, x, z);
          if (margin > best) {
            best = margin;
            if (firstHit && best >= 0) return best;
          }
        }
      }
      return best;
    }

    /** Bucket lists that can hold a stripe covering world (x, z): its detail tile, plus neighbours it is near the edge of. */
    _listsNear(x, z) {
      const { lat, lon } = localToLatLon(x, z, this.originLat, this.originLon, this.scaleLat);
      const fx = lon2tileX(lon, DETAIL_ZOOM);
      const fy = lat2tileY(lat, DETAIL_ZOOM);
      const tx = Math.floor(fx);
      const ty = Math.floor(fy);
      const reach = NEIGHBOUR_REACH_M / tileSizeMeters(DETAIL_ZOOM, lat);
      const lists = [];
      for (let dx = fx - tx < reach ? -1 : 0; dx <= (tx + 1 - fx < reach ? 1 : 0); dx++) {
        for (let dy = fy - ty < reach ? -1 : 0; dy <= (ty + 1 - fy < reach ? 1 : 0); dy++) {
          const list = this._itemsByTile.get(tileKey(tx + dx, ty + dy));
          if (list) lists.push(list);
        }
      }
      return lists;
    }

    /** Half width minus distance from world (x, z) to the segment's centreline. */
    _segmentMargin(seg, x, z) {
      // End points in the current local frame, converted once per origin move.
      let local = seg.local;
      if (local?.frame !== this._frame) {
        const a = latLonToLocal(seg.a.lat, seg.a.lon, this.originLat, this.originLon, this.scaleLat);
        const b = latLonToLocal(seg.b.lat, seg.b.lon, this.originLat, this.originLon, this.scaleLat);
        local = seg.local = { frame: this._frame, ax: a.x, az: a.z, abx: b.x - a.x, abz: b.z - a.z };
      }
      const { ax, az, abx, abz } = local;
      const lenSq = abx * abx + abz * abz;
      const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / lenSq)) : 0;
      return seg.style.linewidth / 2 - Math.hypot(x - (ax + abx * t), z - (az + abz * t));
    }
  };
}
