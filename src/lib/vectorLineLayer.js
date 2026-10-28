// Line overlay (streets.js, rivers.js) on top of tiles/vectorTileLayer.js.
// Segments are split into SEGMENT_MAX_METERS pieces and bucketed by midpoint,
// so long roads/rivers stream tile-by-tile and hug the ground between vertices.

import { BufferGeometry, Float32BufferAttribute, Mesh, MeshBasicMaterial, DoubleSide } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { latLonToLocal, localToLatLon, lon2tileX, lat2tileY, tileSizeMeters } from './geo.js';
import { VectorTileLayer, tileKey } from './tiles/vectorTileLayer.js';
import { DETAIL_ZOOM } from './terrain.js';

const SEGMENT_MAX_METERS = 4;
const METERS_PER_DEGREE = 111_320;
// Point queries look into a neighbouring bucket tile only this close to its edge:
// half the widest stripe (motorway 23 m) plus half a segment, with slack.
const NEIGHBOUR_REACH_M = 20;
// A vertex where this many line ends meet (a line passing through counts 2) is a junction.
const JUNCTION_DEGREE = 3;
// Clearance values are capped, so far-from-junction vertices stay finite in Float32 attributes.
const MAX_CLEARANCE_M = 1000;
// Stripe joints are mitred unless the line turns sharper than this (cos of the half angle).
const MITER_MIN_COS = 0.5;
// A line ending on (or up to END_EXTEND_MAX_M short of) a higher-ranked road is cut back / stretched to that
// road's edge, this far inside it (no seam; the higher road draws on top). Geometric, as tile ends often miss its vertices.
const END_CUT_OVERLAP_M = 0.3;
const END_EXTEND_MAX_M = 2;
const END_GRID_M = 32;
// Not cut when it meets that road at a shallower angle than this (sin): the cut would run far along it.
const END_CUT_MIN_SIN = 0.35;
const NO_CUTS = [];
// segmentsAt() index: each bucket list in a lat/lon grid of about this cell size, segments padded by up to the query margin.
const NEAR_CELL_M = 16;
const NEAR_MAX_MARGIN_M = 2;

/**
 * Builds a manager class (call `new Cls(scene, world, originLat, originLon, terrain)`).
 *
 * @param {object} options
 * @param {number} options.tileZoom
 * @param {string} options.layerName - e.g. 'transportation', 'waterway'.
 * @param {(props: object) => ({key: string, color: number, linewidth: number} | null)} options.classify
 *   A style may also bring its own `material` (`lit`: gets normals and shadows) and `lift`;
 *   with `markings` (a number) its stripes get a `stripe` attribute (metres across from the
 *   centreline, along the line, clear of the nearest junction past its widest road's half
 *   width; half width) and `stripeMarkings` (= `markings`), for road marking shaders.
 *   With `rank` (default: `linewidth`), a flat line ending on a higher-ranked one stops at its edge.
 *   With `depthRank` (a number) its stripes get a `depthRank` attribute (= `depthRank`).
 *   With `renderOrder` its meshes get it.
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
    if (style.material) return style.material;
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
      this._nearGrids = new WeakMap(); // bucket list -> { count, cells }
    }

    // Items also carry `dist` (metres along the line at `a`), `len`, `buffer`
    // (midpoint in the source tile's overlap with its neighbours), `line`
    // (all of its line's items, in order) and `index` in it, for roadside.js kinds.
    // `line.junctions` = flat [dist, widest half width, ...] of its junctions (_finishDecode).
    _decodeFeature(lines, style, toLatLon, add, extent) {
      const inTile = (x, y) => x >= 0 && x < extent && y >= 0 && y < extent;
      for (const line of lines) {
        if (line.length < 2) continue;
        const points = line.map(toLatLon);
        const items = [];
        const vertexKey = (pt) => `${pt.x},${pt.y}`;
        items.vertexKeys = line.map(vertexKey); // tile coords: lines meeting at a node share it exactly
        items.vertexDists = [];
        items.vertexPoints = points;
        items.endsInTile = [line[0], line[line.length - 1]].map((pt) => inTile(pt.x, pt.y));
        let dist = 0;
        for (let p = 0; p < points.length - 1; p++) {
          items.vertexDists.push(dist);
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
            const item = { a: prev, b: next, style, dist, len, buffer: !inTile(mx, my), line: items, index: items.length };
            items.push(item);
            add((prev.lat + next.lat) / 2, (prev.lon + next.lon) / 2, item);
            dist += len;
            prev = next;
          }
        }
        items.vertexDists.push(dist);
      }
    }

    _finishDecode(items) {
      const lines = new Set(items.map((item) => item.line));
      const junctions = new Map(); // vertex key -> { degree, halfWidth }
      for (const line of lines) {
        const halfWidth = (line[0]?.style.linewidth ?? 0) / 2;
        line.vertexKeys.forEach((key, i) => {
          const node = junctions.get(key) ?? { degree: 0, halfWidth: 0 };
          node.degree += i === 0 || i === line.vertexKeys.length - 1 ? 1 : 2;
          node.halfWidth = Math.max(node.halfWidth, halfWidth);
          junctions.set(key, node);
        });
      }
      for (const line of lines) {
        line.junctions = [];
        line.vertexKeys.forEach((key, i) => {
          const node = junctions.get(key);
          if (node.degree >= JUNCTION_DEGREE) line.junctions.push(line.vertexDists[i], node.halfWidth);
        });
      }
      assignEndCuts(lines);
      for (const line of lines) {
        delete line.vertexKeys;
        delete line.vertexDists;
        delete line.vertexPoints;
        delete line.endsInTile;
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
      const styleLift = seg.style.lift ?? lift;
      const ay = this._groundHeightAt(a.x, a.z) + styleLift;
      const by = this._groundHeightAt(b.x, b.z) + styleLift;
      const { positions, stripe, stripeMarkings, depthRank } = this._bucket(byStyleKey, seg.style, () => ({
        positions: [],
        ...(seg.style.markings != null && { stripe: [], stripeMarkings: [] }),
        ...(seg.style.depthRank != null && { depthRank: [] }),
      }));
      if (!flat) {
        positions.push(a.x, ay, a.z, b.x, by, b.z);
        return;
      }
      // Quad offset sideways in XZ only, so the stripe lies on the ground; joints shared with
      // the neighbouring items are mitred, so bends have no gaps or overlaps.
      const n = sideNormal(a, b);
      const hw = seg.style.linewidth / 2;
      const prev = seg.line?.[seg.index - 1];
      const next = seg.line?.[seg.index + 1];
      const [oax, oaz] = prev ? miter(sideNormal(this._toLocal(prev.a), a), n, hw) : [n[0] * hw, n[1] * hw];
      const [obx, obz] = next ? miter(n, sideNormal(b, this._toLocal(next.b)), hw) : [n[0] * hw, n[1] * hw];
      const da = seg.dist;
      const db = seg.dist + seg.len;
      const ca = stripe ? junctionClearance(seg.line.junctions, da) : 0;
      const cb = stripe ? junctionClearance(seg.line.junctions, db) : 0;
      // Corners [x, y, z, across, along, clearance], fanned from the first.
      let poly = [
        [a.x - oax, ay, a.z - oaz, -hw, da, ca],
        [a.x + oax, ay, a.z + oaz, hw, da, ca],
        [b.x + obx, by, b.z + obz, hw, db, cb],
        [b.x - obx, by, b.z - obz, -hw, db, cb],
      ];
      const cuts = this._endCutsOf(seg);
      // Stretch before any clip: stretchEnd needs the 4-corner quad (a one-segment line has both ends here).
      for (const cut of cuts) {
        if (seg.index === (cut.atStart ? 0 : seg.line.length - 1)) poly = stretchEnd(poly, cut);
      }
      for (const cut of cuts) poly = clipPolygon(poly, cut);
      for (let i = 1; i < poly.length - 1; i++) {
        for (const v of [poly[0], poly[i], poly[i + 1]]) {
          positions.push(v[0], v[1], v[2]);
          if (depthRank) depthRank.push(seg.style.depthRank);
          if (stripe) {
            stripe.push(v[3], v[4], v[5], hw);
            stripeMarkings.push(seg.style.markings);
          }
        }
      }
    }

    /** End cut half-planes (local frame) of the line's cut ends `seg` lies near. */
    _endCutsOf(seg) {
      const line = seg.line;
      if (!line?.cuts) return NO_CUTS;
      if (line.cutFrame !== this._frame) {
        line.cutFrame = this._frame;
        line.cutPlanes = line.cuts.map((cut) => this._endCutPlane(line, cut)).filter(Boolean);
      }
      const end = line[line.length - 1];
      const total = end.dist + end.len;
      return line.cutPlanes.filter((p) => (p.atStart ? seg.dist : total - seg.dist - seg.len) < p.reach);
    }

    /** Half-plane beyond the higher road's edge on this line's side, or null if it meets that road too shallow. */
    _endCutPlane(line, { atStart, a, b, back, halfWidth }) {
      const pa = this._toLocal(a);
      const pb = this._toLocal(b);
      const ul = Math.hypot(pb.x - pa.x, pb.z - pa.z);
      if (ul < 1e-6) return null;
      const mx = -(pb.z - pa.z) / ul;
      const mz = (pb.x - pa.x) / ul;
      const e = this._toLocal(atStart ? line[0].a : line[line.length - 1].b);
      const q = this._toLocal(back);
      const sin = ((q.x - e.x) * mx + (q.z - e.z) * mz) / Math.hypot(q.x - e.x, q.z - e.z);
      if (!(Math.abs(sin) >= END_CUT_MIN_SIN)) return null;
      const s = Math.sign((q.x - pa.x) * mx + (q.z - pa.z) * mz) || Math.sign(sin);
      return {
        atStart,
        px: pa.x,
        pz: pa.z,
        nx: s * mx,
        nz: s * mz,
        offset: halfWidth - END_CUT_OVERLAP_M,
        reach: (halfWidth + END_EXTEND_MAX_M) / Math.abs(sin) + SEGMENT_MAX_METERS,
      };
    }

    _toLocal({ lat, lon }) {
      return latLonToLocal(lat, lon, this.originLat, this.originLon, this.scaleLat);
    }

    _shiftBucket({ positions }, dx, dz) {
      for (let i = 0; i < positions.length; i += 3) {
        positions[i] -= dx;
        positions[i + 2] -= dz;
      }
    }

    _makeMesh(bucket) {
      if (flat) {
        let geometry = new BufferGeometry();
        geometry.setAttribute('position', new Float32BufferAttribute(bucket.positions, 3));
        if (bucket.stripe) {
          geometry.setAttribute('stripe', new Float32BufferAttribute(bucket.stripe, 4));
          geometry.setAttribute('stripeMarkings', new Float32BufferAttribute(bucket.stripeMarkings, 1));
        }
        if (bucket.depthRank) geometry.setAttribute('depthRank', new Float32BufferAttribute(bucket.depthRank, 1));
        if (bucket.style.lit) {
          // Mitred joints share their vertices: merged, the normals blend along the road, so highlights don't facet.
          geometry = mergeVertices(geometry);
          geometry.computeVertexNormals();
        }
        const mesh = new Mesh(geometry, materialFor(bucket.style));
        mesh.receiveShadow = !!bucket.style.lit;
        if (bucket.style.renderOrder != null) mesh.renderOrder = bucket.style.renderOrder;
        return mesh;
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
        for (const seg of list) if (this.segmentMargin(seg, x, z) >= 0) yield seg.style;
      }
    }

    /** Fetched segments whose stripe, widened by `margin` (up to NEAR_MAX_MARGIN_M), covers world (x, z). Flat layers only. */
    *segmentsAt(x, z, margin = 0) {
      if (!flat) return;
      const { lat, lon } = localToLatLon(x, z, this.originLat, this.originLon, this.scaleLat);
      const key = nearCellKey(lat, lon);
      for (const list of this._listsNear(x, z)) {
        for (const seg of this._nearGrid(list).get(key) ?? NO_CUTS) if (this.segmentMargin(seg, x, z) >= -margin) yield seg;
      }
    }

    /** Cell -> segments whose stripe plus NEAR_MAX_MARGIN_M reaches into it, rebuilt when the list grows. */
    _nearGrid(list) {
      let grid = this._nearGrids.get(list);
      if (grid?.count === list.length) return grid.cells;
      const cells = new Map();
      for (const seg of list) {
        const reach = seg.style.linewidth / 2 + NEAR_MAX_MARGIN_M;
        const dLat = reach / METERS_PER_DEGREE;
        const dLon = dLat / Math.cos((seg.a.lat * Math.PI) / 180);
        const [x0, y0] = nearCell(Math.min(seg.a.lat, seg.b.lat) - dLat, Math.min(seg.a.lon, seg.b.lon) - dLon);
        const [x1, y1] = nearCell(Math.max(seg.a.lat, seg.b.lat) + dLat, Math.max(seg.a.lon, seg.b.lon) + dLon);
        for (let cx = x0; cx <= x1; cx++) {
          for (let cy = y0; cy <= y1; cy++) {
            const key = `${cx},${cy}`;
            const cell = cells.get(key);
            if (cell) cell.push(seg);
            else cells.set(key, [seg]);
          }
        }
      }
      this._nearGrids.set(list, (grid = { count: list.length, cells }));
      return cells;
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
          const margin = this.segmentMargin(seg, x, z);
          if (margin > best) {
            best = margin;
            if (firstHit && best >= 0) return best;
          }
        }
      }
      return best;
    }

    /** Bucket lists (of `byTile`, default the fetched items) that can hold a stripe covering world (x, z): its detail tile, plus neighbours it is near the edge of. */
    _listsNear(x, z, byTile = this._itemsByTile) {
      const { lat, lon } = localToLatLon(x, z, this.originLat, this.originLon, this.scaleLat);
      const fx = lon2tileX(lon, DETAIL_ZOOM);
      const fy = lat2tileY(lat, DETAIL_ZOOM);
      const tx = Math.floor(fx);
      const ty = Math.floor(fy);
      const reach = NEIGHBOUR_REACH_M / tileSizeMeters(DETAIL_ZOOM, lat);
      const lists = [];
      for (let dx = fx - tx < reach ? -1 : 0; dx <= (tx + 1 - fx < reach ? 1 : 0); dx++) {
        for (let dy = fy - ty < reach ? -1 : 0; dy <= (ty + 1 - fy < reach ? 1 : 0); dy++) {
          const list = byTile.get(tileKey(tx + dx, ty + dy));
          if (list) lists.push(list);
        }
      }
      return lists;
    }

    /** Half width minus distance from world (x, z) to the segment's centreline. */
    segmentMargin(seg, x, z) {
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

/** segmentsAt() grid cell of (lat, lon): [x, y]. */
function nearCell(lat, lon) {
  const size = NEAR_CELL_M / METERS_PER_DEGREE;
  return [Math.floor(lon / size), Math.floor(lat / size)];
}

function nearCellKey(lat, lon) {
  const [x, y] = nearCell(lat, lon);
  return `${x},${y}`;
}

/** Unit XZ normal to the left of a -> b. */
export function sideNormal(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  return len > 1e-6 ? [-dz / len, dx / len] : [1, 0];
}

/** Side offset of half width `hw` at the joint between segments with normals `n0`, `n1`. */
export function miter(n0, n1, hw) {
  const mx = n0[0] + n1[0];
  const mz = n0[1] + n1[1];
  const len = Math.hypot(mx, mz);
  const cos = len / 2;
  if (cos < MITER_MIN_COS) return [n1[0] * hw, n1[1] * hw];
  const scale = hw / (len * cos);
  return [mx * scale, mz * scale];
}

/**
 * Sets `line.cuts` = [{ atStart, a, b (the higher road's segment under the end), back (the line's vertex before
 * the end), halfWidth (the higher road's) }] for ends inside or just short of a higher-ranked line's stripe.
 */
function assignEndCuts(lines) {
  const rankOf = (line) => line[0].style.rank ?? line[0].style.linewidth;
  const first = [...lines][0]?.vertexPoints[0];
  if (!first) return;
  const kx = METERS_PER_DEGREE * Math.cos((first.lat * Math.PI) / 180);
  const cell = (x, y) => `${Math.floor(x / END_GRID_M)},${Math.floor(y / END_GRID_M)}`;
  const grid = new Map(); // cell -> [{ line, k }]: segment from vertex k to k + 1, in every cell its reach box touches
  for (const line of lines) {
    line.xy = line.vertexPoints.map((p) => [p.lon * kx, p.lat * METERS_PER_DEGREE]);
    const reach = line[0].style.linewidth / 2 + END_EXTEND_MAX_M;
    for (let k = 0; k < line.xy.length - 1; k++) {
      const [ax, ay] = line.xy[k];
      const [bx, by] = line.xy[k + 1];
      for (let cx = Math.floor((Math.min(ax, bx) - reach) / END_GRID_M); cx <= Math.floor((Math.max(ax, bx) + reach) / END_GRID_M); cx++) {
        for (let cy = Math.floor((Math.min(ay, by) - reach) / END_GRID_M); cy <= Math.floor((Math.max(ay, by) + reach) / END_GRID_M); cy++) {
          const key = `${cx},${cy}`;
          const list = grid.get(key);
          if (list) list.push({ line, k });
          else grid.set(key, [{ line, k }]);
        }
      }
    }
  }
  for (const line of lines) {
    const n = line.xy.length;
    const cuts = [];
    for (const atStart of [true, false]) {
      if (!line.endsInTile[atStart ? 0 : 1]) continue; // cut at the tile edge: not a real end
      const [ex, ey] = line.xy[atStart ? 0 : n - 1];
      let best = null;
      for (const { line: other, k } of grid.get(cell(ex, ey)) ?? []) {
        const rank = rankOf(other);
        if (other === line || rank <= rankOf(line)) continue;
        const halfWidth = other[0].style.linewidth / 2;
        const d = pointSegmentDist(ex, ey, other.xy[k], other.xy[k + 1]);
        if (d > halfWidth + END_EXTEND_MAX_M) continue;
        if (best && (rank < best.rank || (rank === best.rank && d >= best.d))) continue;
        best = { rank, d, other, k, halfWidth };
      }
      if (!best) continue;
      const pts = best.other.vertexPoints;
      const back = line.vertexPoints[atStart ? 1 : n - 2];
      cuts.push({ atStart, a: pts[best.k], b: pts[best.k + 1], back, halfWidth: best.halfWidth });
    }
    if (cuts.length) line.cuts = cuts;
  }
  for (const line of lines) delete line.xy;
}

function pointSegmentDist(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 1e-12 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq)) : 0;
  return Math.hypot(x - ax - dx * t, y - ay - dy * t);
}

/** Moves the end corners of a line's last quad (fanned [x, y, z, ...] corners) out onto `cut`'s plane when they stop short of it. */
function stretchEnd(poly, cut) {
  const side = (v) => (v[0] - cut.px) * cut.nx + (v[2] - cut.pz) * cut.nz - cut.offset;
  const out = poly.slice();
  for (const [c, o] of cut.atStart ? [[0, 3], [1, 2]] : [[2, 1], [3, 0]]) {
    const sc = side(poly[c]);
    const so = side(poly[o]);
    if (!(sc > 0 && so > sc)) continue;
    const len = Math.hypot(poly[c][0] - poly[o][0], poly[c][2] - poly[o][2]);
    const k = Math.min(so / (so - sc), 1 + (END_EXTEND_MAX_M + END_CUT_OVERLAP_M) / len);
    out[c] = poly[o].map((x, i) => x + (poly[c][i] - x) * k);
  }
  return out;
}

/** Clips a convex polygon of [x, y, z, ...attributes] to the side of `cut` away from its road (attributes interpolated). */
function clipPolygon(poly, { px, pz, nx, nz, offset }) {
  const side = (v) => (v[0] - px) * nx + (v[2] - pz) * nz - offset;
  const out = [];
  for (let k = 0; k < poly.length; k++) {
    const v = poly[k];
    const w = poly[(k + 1) % poly.length];
    const sv = side(v);
    const sw = side(w);
    if (sv >= 0) out.push(v);
    if (sv >= 0 !== sw >= 0) {
      const t = sv / (sv - sw);
      out.push(v.map((x, c) => x + (w[c] - x) * t));
    }
  }
  return out;
}

/** Metres from `dist` along a line to the nearest of its `junctions`, past that junction's widest half width. */
function junctionClearance(junctions, dist) {
  let best = MAX_CLEARANCE_M;
  for (let k = 0; k < (junctions?.length ?? 0); k += 2) best = Math.min(best, Math.abs(dist - junctions[k]) - junctions[k + 1]);
  return best;
}
