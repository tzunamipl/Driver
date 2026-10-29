import { lon2tileX, lat2tileY } from './geo.js';
import { isImperial, longDistanceValue, FT_PER_M } from './units.js';

// Road routes from the public OSRM demo server (keyless, CORS, fair-use),
// flattened into one polyline with per-vertex distance/time so the car's
// progress along it is a nearest-segment lookup.

const OSRM_ROUTE_URL = (points, query = '') =>
  `https://router.project-osrm.org/route/v1/driving/${points.map((p) => `${p.lon},${p.lat}`).join(';')}` +
  `?overview=false&steps=true&geometries=geojson${query}`;

const EARTH_RADIUS = 6371000;
const DEG = Math.PI / 180;
// Within this of the last match, the local window is trusted; beyond it the whole route is scanned.
const LOCAL_MATCH_M = 50;
const LOCAL_WINDOW_BACK = 20;
const LOCAL_WINDOW_AHEAD = 400;
// Avoided roads: alternatives asked for, departure heading tolerance, route vertices this near the line count as on it.
const AVOID_ALTERNATIVES = 3;
const AVOID_BEARING_RANGE = 90;
const AVOID_ON_LINE_M = 25;
// An alternative must cut the metres on the avoided line by this much to beat OSRM's own pick.
const AVOID_MIN_GAIN_M = 50;

/**
 * @typedef {{ type: string, modifier?: string, exit?: number, name: string, index: number, along: number }} RouteStep
 * @typedef {{
 *   lat: Float64Array, lon: Float64Array, mx: Float64Array, my: Float64Array,
 *   cum: Float64Array, cumTime: Float64Array, steps: RouteStep[], distance: number, duration: number,
 *   destination: { lat: number, lon: number },
 * }} Route
 */

/**
 * `avoid`: { line: [{ lat, lon }], bearing?: deg from north } - leave `from` within AVOID_BEARING_RANGE of
 * `bearing`, and of OSRM's alternatives take the one with the fewest metres along `line`.
 * @returns {Promise<Route>}
 */
export async function fetchRoute(from, to, signal, avoid = null) {
  if (!avoid) return fetchRouteVia([from, to], signal);
  const query = `&alternatives=${AVOID_ALTERNATIVES}`;
  let routes = null;
  if (avoid.bearing != null) {
    const bearing = Math.round(((avoid.bearing % 360) + 360) % 360);
    // No road leaving that way near `from` (NoSegment / NoRoute): routed without the heading.
    routes = await requestRoutes([from, to], signal, `${query}&bearings=${bearing},${AVOID_BEARING_RANGE};`).catch((err) => {
      if (signal?.aborted) throw err;
      return null;
    });
  }
  routes ??= await requestRoutes([from, to], signal, query);
  const options = routes.map((r) => r.legs.flatMap((leg) => leg.steps)).filter((steps) => steps.length);
  if (!options.length) throw new Error('no road route found');
  const onLine = options.map((steps) => metresOnLine(steps, avoid.line));
  let pick = 0;
  onLine.forEach((m, i) => {
    if (m < onLine[pick] - AVOID_MIN_GAIN_M) pick = i;
  });
  return buildRoute(options[pick], to);
}

async function requestRoutes(points, signal, query = '') {
  const res = await fetch(OSRM_ROUTE_URL(points, query), { signal, headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => null);
  if (data?.code !== 'Ok' || !data.routes?.length) {
    throw new Error(data?.code === 'NoRoute' ? 'no road route found' : data?.message || `routing failed (${res.status})`);
  }
  return data.routes;
}

/** Metres of the OSRM steps' geometry within AVOID_ON_LINE_M of the polyline `line`. */
function metresOnLine(steps, line) {
  if (!line?.length) return 0;
  const lat0 = line[0].lat;
  const kx = Math.cos(lat0 * DEG) * DEG * EARTH_RADIUS;
  const ky = DEG * EARTH_RADIUS;
  const lx = line.map((p) => (p.lon - line[0].lon) * kx);
  const ly = line.map((p) => (p.lat - lat0) * ky);
  const near = (x, y) => {
    if (lx.length === 1) return Math.hypot(x - lx[0], y - ly[0]) < AVOID_ON_LINE_M;
    for (let i = 0; i + 1 < lx.length; i++) {
      const ex = lx[i + 1] - lx[i];
      const ey = ly[i + 1] - ly[i];
      const len2 = ex * ex + ey * ey;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - lx[i]) * ex + (y - ly[i]) * ey) / len2)) : 0;
      if (Math.hypot(x - lx[i] - ex * t, y - ly[i] - ey * t) < AVOID_ON_LINE_M) return true;
    }
    return false;
  };
  let metres = 0;
  for (const step of steps) {
    const pts = step.geometry.coordinates.map(([lon, lat]) => [(lon - line[0].lon) * kx, (lat - lat0) * ky]);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      if (near((ax + bx) / 2, (ay + by) / 2)) metres += Math.hypot(bx - ax, by - ay);
    }
  }
  return metres;
}

/** Initial bearing from a to b ({ lat, lon }), degrees clockwise from north. */
export function bearingDeg(a, b) {
  const dLon = (b.lon - a.lon) * DEG;
  const y = Math.sin(dLon) * Math.cos(b.lat * DEG);
  const x = Math.cos(a.lat * DEG) * Math.sin(b.lat * DEG) - Math.sin(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.cos(dLon);
  return Math.atan2(y, x) / DEG;
}

/**
 * Road route through every waypoint in order; `legStarts[i]` = first vertex of the leg
 * from waypoint i to i + 1 (the leg ends where the next one starts, the last at the end).
 * @returns {Promise<Route & { legStarts: number[] }>}
 */
export async function fetchRouteVia(points, signal) {
  const [{ legs }] = await requestRoutes(points, signal);
  const steps = legs.flatMap((leg) => leg.steps);
  if (!steps.length) throw new Error('no road route found');
  const route = buildRoute(steps, points[points.length - 1]);
  let firstStep = 0;
  route.legStarts = legs.map((leg) => {
    const start = route.steps[Math.min(firstStep, steps.length - 1)].index;
    firstStep += leg.steps.length;
    return start;
  });
  return route;
}

function buildRoute(osrmSteps, destination) {
  const coords = [];
  const stepStarts = [];
  for (const step of osrmSteps) {
    const pts = step.geometry.coordinates;
    const last = coords[coords.length - 1];
    const skipFirst = last && last[0] === pts[0][0] && last[1] === pts[0][1];
    stepStarts.push(skipFirst ? coords.length - 1 : coords.length);
    for (let i = skipFirst ? 1 : 0; i < pts.length; i++) coords.push(pts[i]);
  }
  const n = coords.length;
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const mx = new Float64Array(n);
  const my = new Float64Array(n);
  const cum = new Float64Array(n);
  const cumTime = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lon[i] = coords[i][0];
    lat[i] = coords[i][1];
    mx[i] = lon2tileX(lon[i], 0);
    my[i] = lat2tileY(lat[i], 0);
    if (i > 0) cum[i] = cum[i - 1] + segmentMeters(lat[i - 1], lon[i - 1], lat[i], lon[i]);
  }
  // A step's duration is spread over its own vertices by distance.
  osrmSteps.forEach((step, s) => {
    const start = stepStarts[s];
    const end = s + 1 < stepStarts.length ? stepStarts[s + 1] : n - 1;
    const span = cum[end] - cum[start];
    for (let i = start + 1; i <= end; i++) {
      cumTime[i] = cumTime[start] + (span > 0 ? ((cum[i] - cum[start]) / span) * step.duration : 0);
    }
  });
  const steps = osrmSteps.map((step, s) => ({
    type: step.maneuver.type,
    modifier: step.maneuver.modifier,
    exit: step.maneuver.exit,
    name: step.name || step.ref || '',
    index: stepStarts[s],
    along: cum[stepStarts[s]],
  }));
  return {
    lat, lon, mx, my, cum, cumTime, steps,
    distance: cum[n - 1],
    duration: cumTime[n - 1],
    destination: { lat: destination.lat, lon: destination.lon },
  };
}

function segmentMeters(lat1, lon1, lat2, lon2) {
  const dx = (lon2 - lon1) * DEG * Math.cos(((lat1 + lat2) / 2) * DEG);
  const dy = (lat2 - lat1) * DEG;
  return Math.hypot(dx, dy) * EARTH_RADIUS;
}

/**
 * Nearest point of the route to (lat, lon), searched near `hint` (the last
 * match) first so a route that doubles back doesn't jump ahead.
 * @returns {{ index: number, t: number, along: number, time: number, offRouteM: number }}
 */
export function locateOnRoute(route, lat, lon, hint = 0) {
  const n = route.lat.length;
  if (n < 2) return { index: 0, t: 0, along: 0, time: 0, offRouteM: 0 };
  let best = scan(route, lat, lon, Math.max(0, hint - LOCAL_WINDOW_BACK), Math.min(n - 1, hint + LOCAL_WINDOW_AHEAD));
  if (best.offRouteM > LOCAL_MATCH_M) {
    const full = scan(route, lat, lon, 0, n - 1);
    if (full.offRouteM < best.offRouteM) best = full;
  }
  const { index: i, t } = best;
  best.along = route.cum[i] + (route.cum[i + 1] - route.cum[i]) * t;
  best.time = route.cumTime[i] + (route.cumTime[i + 1] - route.cumTime[i]) * t;
  return best;
}

// Segments [from, to) in flat metres around the car.
function scan(route, lat, lon, from, to) {
  const kx = Math.cos(lat * DEG) * DEG * EARTH_RADIUS;
  const ky = DEG * EARTH_RADIUS;
  let best = { index: from, t: 0, along: 0, time: 0, offRouteM: Infinity };
  let ax = (route.lon[from] - lon) * kx;
  let ay = (route.lat[from] - lat) * ky;
  for (let i = from; i < to; i++) {
    const bx = (route.lon[i + 1] - lon) * kx;
    const by = (route.lat[i + 1] - lat) * ky;
    const ex = bx - ax;
    const ey = by - ay;
    const len2 = ex * ex + ey * ey;
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * ex + ay * ey) / len2)) : 0;
    const d = Math.hypot(ax + ex * t, ay + ey * t);
    if (d < best.offRouteM) best = { index: i, t, along: 0, time: 0, offRouteM: d };
    ax = bx;
    ay = by;
  }
  return best;
}

const ARROWS = {
  uturn: '↶',
  'sharp right': '↘',
  right: '→',
  'slight right': '↗',
  straight: '↑',
  'slight left': '↖',
  left: '←',
  'sharp left': '↙',
};

function turnPhrase(modifier) {
  if (!modifier || modifier === 'straight') return 'Continue straight';
  if (modifier === 'uturn') return 'Make a U-turn';
  if (modifier.startsWith('slight ')) return `Bear ${modifier.slice(6)}`;
  return `Turn ${modifier}`;
}

/** { arrow, text } for an OSRM maneuver, e.g. { '→', 'Turn right onto Main St' }. */
export function describeStep(step) {
  const onto = step.name ? ` onto ${step.name}` : '';
  const side = step.modifier?.includes('left') ? 'left' : 'right';
  switch (step.type) {
    case 'arrive':
      return { arrow: '⚑', text: 'Arrive at destination' };
    case 'roundabout':
    case 'rotary':
      return { arrow: '⟳', text: step.exit ? `At the roundabout take exit ${step.exit}${onto}` : `Enter the roundabout${onto}` };
    case 'fork':
      return { arrow: ARROWS[step.modifier] ?? '↑', text: `Keep ${side}${onto}` };
    case 'merge':
      return { arrow: ARROWS[step.modifier] ?? '↑', text: `Merge${onto}` };
    case 'on ramp':
      return { arrow: ARROWS[step.modifier] ?? '↑', text: `Take the ramp${onto}` };
    case 'off ramp':
      return { arrow: ARROWS[step.modifier] ?? '↑', text: `Take the exit${onto}` };
    case 'new name':
    case 'continue':
      if (!step.modifier || step.modifier === 'straight') return { arrow: '↑', text: `Continue${onto}` };
      return { arrow: ARROWS[step.modifier], text: `${turnPhrase(step.modifier)}${onto}` };
    default:
      return { arrow: ARROWS[step.modifier] ?? '↑', text: `${turnPhrase(step.modifier)}${onto}` };
  }
}

export function formatRouteDistance(meters) {
  if (isImperial()) {
    const miles = longDistanceValue(meters / 1000);
    if (miles < 0.1) return `${Math.max(0, Math.round((meters * FT_PER_M) / 50) * 50)} ft`;
    return `${miles.toFixed(miles < 10 ? 1 : 0)} mi`;
  }
  if (meters < 1000) return `${Math.max(0, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

export function formatRouteDuration(seconds) {
  const min = Math.round(seconds / 60);
  if (min < 1) return '< 1 min';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
