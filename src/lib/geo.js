// Geographic helpers: lat/lon <-> slippy-map tile coordinates, and
// lat/lon <-> local flat "meters" coordinates centered on an origin point.
//
// The local projection is a simple equirectangular (flat-earth) approximation
// around a fixed origin. It's accurate to well under 1% error for the few-km
// scale of a driving area, which is all a raycast-vehicle physics sim needs.

const EARTH_RADIUS = 6378137; // WGS84 equatorial radius, meters

export function lon2tileX(lon, zoom) {
  return ((lon + 180) / 360) * 2 ** zoom;
}

export function lat2tileY(lat, zoom) {
  const latRad = (lat * Math.PI) / 180;
  return (
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
    2 ** zoom
  );
}

export function tileX2lon(x, zoom) {
  return (x / 2 ** zoom) * 360 - 180;
}

export function tileY2lat(y, zoom) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** zoom;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Converts lat/lon to local meters (x = east, z = south) relative to origin.
 * Three.js uses a right-handed system here with +Z pointing "south" so that
 * north is -Z, matching typical top-down map orientation with north "up/away".
 */
export function latLonToLocal(lat, lon, originLat, originLon) {
  const originLatRad = (originLat * Math.PI) / 180;
  const dLat = ((lat - originLat) * Math.PI) / 180;
  const dLon = ((lon - originLon) * Math.PI) / 180;
  const x = dLon * Math.cos(originLatRad) * EARTH_RADIUS;
  const z = -dLat * EARTH_RADIUS;
  return { x, z };
}

/** Inverse of latLonToLocal. */
export function localToLatLon(x, z, originLat, originLon) {
  const originLatRad = (originLat * Math.PI) / 180;
  const lat = originLat + (-z / EARTH_RADIUS) * (180 / Math.PI);
  const lon = originLon + (x / (EARTH_RADIUS * Math.cos(originLatRad))) * (180 / Math.PI);
  return { lat, lon };
}

/**
 * Re-expresses a local (x, z) point defined relative to one origin as the
 * equivalent local (x, z) point relative to a different origin, by
 * round-tripping through lat/lon. Used to keep multiplayer pose sync
 * correct when a single player's own "view" origin (what their terrain is
 * streamed/centered around) has personally diverged from the shared
 * network origin everyone's poses are encoded against - e.g. after that
 * player teleports elsewhere via the address search without moving anyone
 * else's world (see ui/addressSearch.js). A no-op (returns x, z unchanged)
 * when the two origins are identical, which is the common case.
 */
export function remapLocalOrigin(x, z, fromOriginLat, fromOriginLon, toOriginLat, toOriginLon) {
  if (fromOriginLat === toOriginLat && fromOriginLon === toOriginLon) return { x, z };
  const { lat, lon } = localToLatLon(x, z, fromOriginLat, fromOriginLon);
  return latLonToLocal(lat, lon, toOriginLat, toOriginLon);
}

/**
 * Approximate ground size (meters, per edge) of a Web Mercator slippy-map
 * tile at a given zoom and latitude. Web Mercator tiles are square in
 * projected space but shrink in real-world ground size away from the
 * equator by a factor of cos(lat); used to convert a real-world LOD radius
 * (e.g. "150km") into a tile-count radius at a given zoom level.
 */
export function tileSizeMeters(zoom, lat) {
  const latRad = (lat * Math.PI) / 180;
  return ((2 * Math.PI * EARTH_RADIUS) / 2 ** zoom) * Math.cos(latRad);
}
