import { lon2tileX, lat2tileY } from './geo.js';
import { isImperial, longDistanceValue, FT_PER_M } from './units.js';

// Road routes from the public OSRM demo server (keyless, CORS, fair-use),
// flattened into one polyline with per-vertex distance/time so the car's
// progress along it is a nearest-segment lookup.

const OSRM_ROUTE_URL = (points) =>
  `https://router.project-osrm.org/route/v1/driving/${points.map((p) => `${p.lon},${p.lat}`).join(';')}` +
  '?overview=false&steps=true&geometries=geojson';

const EARTH_RADIUS = 6371000;
const DEG = Math.PI / 180;
// Within this of the last match, the local window is trusted; beyond it the whole route is scanned.
const LOCAL_MATCH_M = 50;
const LOCAL_WINDOW_BACK = 20;
const LOCAL_WINDOW_AHEAD = 400;

/**
 * @typedef {{ type: string, modifier?: string, exit?: number, name: string, index: number, along: number }} RouteStep
 * @typedef {{
 *   lat: Float64Array, lon: Float64Array, mx: Float64Array, my: Float64Array,
 *   cum: Float64Array, cumTime: Float64Array, steps: RouteStep[], distance: number, duration: number,
 *   destination: { lat: number, lon: number },
 * }} Route
 */

/** @returns {Promise<Route>} */
export function fetchRoute(from, to, signal) {
  return fetchRouteVia([from, to], signal);
}

/**
 * Road route through every waypoint in order; `legStarts[i]` = first vertex of the leg
 * from waypoint i to i + 1 (the leg ends where the next one starts, the last at the end).
 * @returns {Promise<Route & { legStarts: number[] }>}
 */
export async function fetchRouteVia(points, signal) {
  const res = await fetch(OSRM_ROUTE_URL(points), { signal, headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => null);
  if (data?.code !== 'Ok' || !data.routes?.length) {
    throw new Error(data?.code === 'NoRoute' ? 'no road route found' : data?.message || `routing failed (${res.status})`);
  }
  const legs = data.routes[0].legs;
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
