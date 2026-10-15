// Building footprints from the OpenFreeMap `building` layer (shared by the
// detailed near buildings and the far box layer), plus footprint helpers.

import * as THREE from 'three';
import { tileX2lon, tileY2lat, lon2tileX, lat2tileY } from '../geo.js';
import { fetchVectorTileLayer } from '../tiles/openFreeMap.js';
import { DETAIL_ZOOM } from '../terrain.js';

export const BUILDING_TILE_ZOOM = 14; // the building layer's maxzoom

const DEFAULT_HEIGHT_METERS = 6; // when render_height is missing
const MIN_HEIGHT_METERS = 2;

export const MIN_FOOTPRINT_POINTS = 3;
export const MAX_FOOTPRINT_METERS = 500; // larger = bad data at this scale

const MAX_FEATURES_PER_TILE = 8000; // cap for dense city tiles
const FEATURE_MEMO_TILES = 12; // decoded z14 tiles kept in memory
const _featureMemo = new Map(); // "tx_ty" -> Promise<features[]>, oldest first

// The optional `colour` field is a hex string or CSS keyword; anything
// else counts as missing and gets the deterministic grey fallback.
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const _parsedColorCache = new Map(); // raw `colour` string -> plain 0xRRGGBB int (or null if unrecognized)
const _colorParseScratch = new THREE.Color();

// Untagged buildings get a stable grey derived from their OSM id, so a
// block isn't one flat colour but each building stays the same shade.
const FALLBACK_GREY_LIGHT = 0xd8; // single channel, 0-255 - grayscale, so R=G=B
const FALLBACK_GREY_DARK = 0x58;

// FNV-1a over the id string (OSM ids exceed 32 bits, so no bitwise ops on them).
function fnv1aHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic grey (0xRRGGBB) for a stable building key. */
function greyFromKey(key) {
  const t = fnv1aHash(String(key)) / 0xffffffff;
  const channel = Math.round(FALLBACK_GREY_DARK + t * (FALLBACK_GREY_LIGHT - FALLBACK_GREY_DARK));
  return channel * 0x010101;
}

// Returns a plain int (not THREE.Color) so it survives IndexedDB cloning.
function parseBuildingColor(props) {
  const raw = props && props.colour;
  if (typeof raw !== 'string' || !raw) return null;
  const trimmed = raw.trim();
  if (_parsedColorCache.has(trimmed)) return _parsedColorCache.get(trimmed);
  let hex = null;
  if (HEX_COLOR_RE.test(trimmed) || THREE.Color.NAMES[trimmed.toLowerCase()] !== undefined) {
    hex = _colorParseScratch.setStyle(trimmed).getHex();
  }
  _parsedColorCache.set(trimmed, hex);
  return hex;
}

/**
 * Decoded buildings of one z14 tile: [{ ring: [{lat, lon}], height, color,
 * detailTx, detailTy }], the detail tile being the one holding the vertex
 * mean. Memoized so the near and far layers share one fetch.
 */
export function fetchBuildingFeatures(tx14, ty14) {
  const key = `${tx14}_${ty14}`;
  let promise = _featureMemo.get(key);
  if (promise) {
    _featureMemo.delete(key); // re-insert as most recent
  } else {
    promise = decodeBuildingTile(tx14, ty14);
    promise.catch(() => _featureMemo.delete(key)); // failures are retried
  }
  _featureMemo.set(key, promise);
  while (_featureMemo.size > FEATURE_MEMO_TILES) _featureMemo.delete(_featureMemo.keys().next().value);
  return promise;
}

async function decodeBuildingTile(tx14, ty14) {
  const layer = await fetchVectorTileLayer(BUILDING_TILE_ZOOM, tx14, ty14, 'building');
  const features = [];
  if (!layer) return features;

  const featureCount = Math.min(layer.length, MAX_FEATURES_PER_TILE);
  for (let i = 0; i < featureCount; i++) {
    try {
      const feature = layer.feature(i);
      if (feature.properties.hide_3d) continue; // covered by a more detailed part

      const rings = feature.loadGeometry();
      if (!rings.length) continue;
      const outer = rings[0];
      if (outer.length < MIN_FOOTPRINT_POINTS) continue;

      const extent = layer.extent;
      const ring = outer.map((p) => ({
        lat: tileY2lat(ty14 + p.y / extent, BUILDING_TILE_ZOOM),
        lon: tileX2lon(tx14 + p.x / extent, BUILDING_TILE_ZOOM),
      }));

      const height = parseHeightMeters(feature.properties);
      const color = parseBuildingColor(feature.properties) ?? greyFromKey(feature.id != null ? feature.id : `${tx14}_${ty14}_${i}`);

      let sumLat = 0;
      let sumLon = 0;
      for (const p of ring) {
        sumLat += p.lat;
        sumLon += p.lon;
      }
      const detailTx = Math.floor(lon2tileX(sumLon / ring.length, DETAIL_ZOOM));
      const detailTy = Math.floor(lat2tileY(sumLat / ring.length, DETAIL_ZOOM));
      features.push({ ring, height, color, detailTx, detailTy });
    } catch (err) {
      console.warn('Skipping one malformed building feature', tx14, ty14, err);
    }
  }
  return features;
}

function parseHeightMeters(props) {
  if (!props) return DEFAULT_HEIGHT_METERS;
  const meters = parseFloat(props.render_height);
  if (Number.isFinite(meters) && meters > 0) return Math.max(MIN_HEIGHT_METERS, meters);
  return DEFAULT_HEIGHT_METERS;
}

/**
 * Convex hull of {x, z} points (Andrew's monotone chain), CCW - the
 * physics shape must be convex; the render mesh uses the exact outline.
 */
export function convexHull2D(points) {
  const pts = points
    .slice()
    .sort((a, b) => a.x - b.x || a.z - b.z)
    .filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x || p.z !== arr[i - 1].z); // drop repeats
  if (pts.length < 3) return pts;

  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
