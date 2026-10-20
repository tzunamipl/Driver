import { fetchRoute, locateOnRoute, describeStep } from '../lib/routing.js';

// Route guidance to the Navigation tab's destination: fetches one route
// (no rerouting when the car strays) and tracks progress along it each frame.

// Remaining distance under which the car counts as arrived.
const ARRIVED_M = 30;
// A maneuver this close behind the car is treated as done.
const PASSED_STEP_M = 5;
const ERROR_SHOW_MS = 5000;

/**
 * @typedef {{
 *   status: 'idle' | 'loading' | 'active' | 'error',
 *   route: import('../lib/routing.js').Route | null,
 *   error: string | null,
 *   progress: { index: number, t: number, remainingM: number, remainingS: number, arrived: boolean,
 *     next: { arrow: string, text: string, distanceM: number } | null } | null,
 * }} RouteState
 */

/**
 * @param {object} deps
 * @param {() => ({ lat: number, lon: number } | null)} deps.getCarLatLon
 * @param {(state: RouteState) => void} [deps.onStatusChange]
 */
export function createRouteGuidance({ getCarLatLon, onStatusChange }) {
  /** @type {RouteState} */
  const state = { status: 'idle', route: null, error: null, progress: null };
  let abort = null;
  let errorTimer = 0;

  function setStatus(status, error = null) {
    state.status = status;
    state.error = error;
    clearTimeout(errorTimer);
    if (status === 'error') errorTimer = setTimeout(() => setStatus('idle'), ERROR_SHOW_MS);
    onStatusChange?.(state);
  }

  /** Routes from the car to `destination`, replacing any current route. */
  async function start(destination) {
    abort?.abort();
    const from = getCarLatLon();
    if (!from) return;
    const controller = new AbortController();
    abort = controller;
    state.route = null;
    state.progress = null;
    setStatus('loading');
    try {
      const route = await fetchRoute(from, destination, controller.signal);
      if (abort !== controller) return;
      state.route = route;
      setStatus('active');
    } catch (err) {
      if (abort !== controller) return;
      setStatus('error', err.message);
    } finally {
      if (abort === controller) abort = null;
    }
  }

  function stop() {
    abort?.abort();
    abort = null;
    state.route = null;
    state.progress = null;
    setStatus('idle');
  }

  function update(lat, lon) {
    const { route } = state;
    if (!route) return;
    const at = locateOnRoute(route, lat, lon, state.progress?.index ?? 0);
    const remainingM = route.distance - at.along;
    const arrived = remainingM < ARRIVED_M;
    const step = arrived ? null : route.steps.find((s) => s.along > at.along + PASSED_STEP_M);
    state.progress = {
      index: at.index,
      t: at.t,
      remainingM,
      remainingS: route.duration - at.time,
      arrived,
      next: step ? { ...describeStep(step), distanceM: step.along - at.along } : null,
    };
  }

  return {
    start,
    stop,
    update,
    /** True while a route is loaded or loading. */
    isNavigating: () => state.status === 'active' || state.status === 'loading',
    getState: () => state,
  };
}
