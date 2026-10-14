import { latLonToLocal, localToLatLon, remapLocalOrigin } from '../lib/geo.js';
import { ORIGIN_LAT, ORIGIN_LON } from '../config.js';

// This player's local frame: metres from (lat, lon), with the east-west
// scale fixed at scaleLat. Poses are exchanged in the network frame (fixed
// at ORIGIN); the view frame moves on teleport (new scaleLat) and on
// floating-origin shifts (scaleLat kept, so a shift is a pure translation).

export function createViewFrame(lat, lon) {
  const frame = { lat, lon, scaleLat: lat };
  return {
    /** Live { lat, lon, scaleLat } - read-only for callers. */
    get: () => frame,
    set(nextLat, nextLon, nextScaleLat = nextLat) {
      frame.lat = nextLat;
      frame.lon = nextLon;
      frame.scaleLat = nextScaleLat;
    },
    toLatLon: (x, z) => localToLatLon(x, z, frame.lat, frame.lon, frame.scaleLat),
    fromLatLon: (lat, lon) => latLonToLocal(lat, lon, frame.lat, frame.lon, frame.scaleLat),
    toNetwork: (x, z) => remapLocalOrigin(x, z, frame.lat, frame.lon, ORIGIN_LAT, ORIGIN_LON, frame.scaleLat, ORIGIN_LAT),
    fromNetwork: (x, z) => remapLocalOrigin(x, z, ORIGIN_LAT, ORIGIN_LON, frame.lat, frame.lon, ORIGIN_LAT, frame.scaleLat),
  };
}
