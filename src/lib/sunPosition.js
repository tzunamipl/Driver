// Apparent sun direction for a UTC instant and observer lat/lon (low-precision
// almanac formulae, ~0.01 deg accuracy for 1950-2050; no refraction).

const DEG = Math.PI / 180;
const MS_PER_DAY = 86_400_000;
const UNIX_EPOCH_JD = 2440587.5;
const J2000_JD = 2451545.0;

/** Unit vector to the sun as { east, north, up } for `timeMs` (Unix ms) at lat/lon (deg). */
export function sunDirection(timeMs, lat, lon) {
  const d = timeMs / MS_PER_DAY + UNIX_EPOCH_JD - J2000_JD;

  const meanAnomaly = (357.529 + 0.98560028 * d) * DEG;
  const meanLongitude = 280.459 + 0.98564736 * d;
  const eclipticLon = (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG;
  const obliquity = (23.439 - 0.00000036 * d) * DEG;

  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLon), Math.cos(eclipticLon));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLon));

  const siderealDeg = (18.697374558 + 24.06570982441908 * d) * 15 + lon;
  const hourAngle = siderealDeg * DEG - rightAscension;

  const latRad = lat * DEG;
  const sinDec = Math.sin(declination);
  const cosDec = Math.cos(declination);
  const cosH = Math.cos(hourAngle);
  return {
    east: -cosDec * Math.sin(hourAngle),
    north: sinDec * Math.cos(latRad) - cosDec * cosH * Math.sin(latRad),
    up: sinDec * Math.sin(latRad) + cosDec * cosH * Math.cos(latRad),
  };
}
