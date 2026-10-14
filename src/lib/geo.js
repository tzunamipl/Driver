// lat/lon <-> slippy tiles, and lat/lon <-> local flat metres around an
// origin (equirectangular; <1% error at driving-area scale).

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

/** lat/lon -> local metres (x = east, z = south) relative to the origin. */
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
 * Re-expresses local (x, z) from one origin relative to another (via
 * lat/lon) - network origin vs a teleported view origin. No-op if equal.
 */
export function remapLocalOrigin(x, z, fromOriginLat, fromOriginLon, toOriginLat, toOriginLon) {
  if (fromOriginLat === toOriginLat && fromOriginLon === toOriginLon) return { x, z };
  const { lat, lon } = localToLatLon(x, z, fromOriginLat, fromOriginLon);
  return latLonToLocal(lat, lon, toOriginLat, toOriginLon);
}

/** Ground edge length (m) of a tile at `zoom` and latitude (shrinks by cos(lat)). */
export function tileSizeMeters(zoom, lat) {
  const latRad = (lat * Math.PI) / 180;
  return ((2 * Math.PI * EARTH_RADIUS) / 2 ** zoom) * Math.cos(latRad);
}
