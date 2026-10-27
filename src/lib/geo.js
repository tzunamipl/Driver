// lat/lon <-> slippy tiles, and lat/lon <-> local flat metres around an
// origin (equirectangular; <1% error at driving-area scale). The east-west
// scale comes from `scaleLat` (default: the origin's latitude). The mapping
// is affine in lat/lon, so moving the origin with scaleLat kept is an exact
// translation - what the floating origin relies on.

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
export function latLonToLocal(lat, lon, originLat, originLon, scaleLat = originLat) {
  const scaleLatRad = (scaleLat * Math.PI) / 180;
  const dLat = ((lat - originLat) * Math.PI) / 180;
  const dLon = ((lon - originLon) * Math.PI) / 180;
  const x = dLon * Math.cos(scaleLatRad) * EARTH_RADIUS;
  const z = -dLat * EARTH_RADIUS;
  return { x, z };
}

/** Inverse of latLonToLocal. */
export function localToLatLon(x, z, originLat, originLon, scaleLat = originLat) {
  const scaleLatRad = (scaleLat * Math.PI) / 180;
  const lat = originLat + (-z / EARTH_RADIUS) * (180 / Math.PI);
  const lon = originLon + (x / (EARTH_RADIUS * Math.cos(scaleLatRad))) * (180 / Math.PI);
  return { lat, lon };
}

/** Great-circle distance in metres. */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * toRad) / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(((lon2 - lon1) * toRad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Re-expresses local (x, z) from one frame in another (via lat/lon) -
 * network frame vs this player's view frame. No-op if equal.
 */
export function remapLocalOrigin(
  x,
  z,
  fromOriginLat,
  fromOriginLon,
  toOriginLat,
  toOriginLon,
  fromScaleLat = fromOriginLat,
  toScaleLat = toOriginLat
) {
  if (fromOriginLat === toOriginLat && fromOriginLon === toOriginLon && fromScaleLat === toScaleLat) return { x, z };
  const { lat, lon } = localToLatLon(x, z, fromOriginLat, fromOriginLon, fromScaleLat);
  return latLonToLocal(lat, lon, toOriginLat, toOriginLon, toScaleLat);
}

/** Ground edge length (m) of a tile at `zoom` and latitude (shrinks by cos(lat)). */
export function tileSizeMeters(zoom, lat) {
  const latRad = (lat * Math.PI) / 180;
  return ((2 * Math.PI * EARTH_RADIUS) / 2 ** zoom) * Math.cos(latRad);
}
