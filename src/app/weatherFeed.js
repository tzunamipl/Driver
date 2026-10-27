// Real weather at the car: Open-Meteo hourly forecast (free, no key) for its lat/lon,
// read at the simulated time of day (daylight.js), so temperature follows day and night
// and place. Feeds lib/weather.js: air temperature, visibility (fog) and the cloud preset (unless the
// debug panel overrides it), and with live wetness on (debug) the road wetness: seeded from the
// last day's weather, then carried on by the weather now, debug overrides included
// (lib/rally/rallyWeather.js model). Offline / failed fetches keep the last values.

import { TIME_SCALE, WEATHER_REFETCH_KM, WEATHER_REFETCH_MIN } from '../config.js';
import { getAirTempOverrideC, getRainOverrideMmH, setAirTempC, setCloudPreset, setForecast, setVisibilityM, setWetness } from '../lib/weather.js';
import { integrateWetness, stepWetness, visibilityFor, MS_PER_DAY } from '../lib/rally/rallyWeather.js';
import { sunDirection } from '../lib/sunPosition.js';

const API_URL = 'https://api.open-meteo.com/v1/forecast';
const HOURLY = ['temperature_2m', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'precipitation', 'weather_code', 'wind_speed_10m', 'visibility'];
const FETCH_TIMEOUT_MS = 10_000;
const RETRY_AFTER_MS = 5 * 60_000;
const SAMPLE_INTERVAL_MS = 2_000;
const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;
const MS_PER_HOUR = 3_600_000;
// Cloud cover (%) a forced preset stands for in the wetness model (only the total shades the sun).
const PRESET_COVER = { clear: 0, fair: 20, cumulus: 50, cirrus: 30, patchy: 60, broken: 80, overcast: 100 };

function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/**
 * Sky preset from cloud cover (%) by altitude and the WMO weather code: rain, snow, fog
 * or a thick low / mid deck = overcast, a thinner one = broken / patchy; heaped low / mid
 * cloud = cumulus; high cloud alone = cirrus.
 */
export function classifyClouds({ total, low, mid, high, code }) {
  const deck = Math.max(low, mid);
  if (code >= 45 || deck >= 90) return 'overcast';
  if (deck >= 70) return 'broken';
  if (deck >= 50) return 'patchy';
  if (low + mid * 0.7 >= 40) return 'cumulus';
  if (high >= 40 && low + mid < 25) return 'cirrus';
  return total >= 10 ? 'fair' : 'clear';
}

async function fetchForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    hourly: HOURLY.join(','),
    timeformat: 'unixtime',
    timezone: 'GMT',
    wind_speed_unit: 'ms',
    // The simulated clock wraps inside the real UTC day: yesterday..tomorrow covers every offset.
    past_days: '1',
    forecast_days: '2',
  });
  const res = await fetch(`${API_URL}?${params}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const { hourly } = await res.json();
  if (!hourly?.time?.length) throw new Error('Open-Meteo: no hourly data');
  return hourly;
}

/** Linear interpolation of an hourly series at index `i + t`. */
function lerpAt(series, i, t) {
  const a = series[i];
  const b = series[Math.min(i + 1, series.length - 1)];
  if (a == null) return b ?? 0;
  if (b == null) return a;
  return a + (b - a) * t;
}

export function createWeatherFeed() {
  let hourly = null;
  let fetchedAt = { lat: 0, lon: 0, ms: 0 };
  let inFlight = false;
  let retryAt = 0;
  let nextSampleAt = 0;
  let cloudOverride = null;
  let enabled = true;
  let liveWetness = false;
  let hours = null; // hourly as rallyWeather.js snapshots, for the wetness model
  let wetness = null; // live road wetness carried on, null = seed from the history
  let wetAtRealMs = 0;

  function refetch(lat, lon, moved) {
    inFlight = true;
    fetchForecast(lat, lon)
      .then((data) => {
        hourly = data;
        hours = data.time.map((s, i) => ({
          ms: s * 1000,
          tempC: data.temperature_2m[i] ?? 0,
          cover: { total: data.cloud_cover[i] ?? 0, low: data.cloud_cover_low[i] ?? 0, mid: data.cloud_cover_mid[i] ?? 0, high: data.cloud_cover_high[i] ?? 0 },
          code: data.weather_code[i] ?? 0,
          precipMmH: data.precipitation[i] ?? 0,
          windMs: data.wind_speed_10m[i] ?? 0,
        }));
        fetchedAt = { lat, lon, ms: Date.now() };
        nextSampleAt = 0;
        // Somewhere else: its own rain history, not the wetness carried from the last place.
        if (moved) wetness = null;
      })
      .catch((err) => {
        console.warn('Weather forecast unavailable:', err.message);
        retryAt = Date.now() + RETRY_AFTER_MS;
      })
      .finally(() => {
        inFlight = false;
      });
  }

  function sample(timeMs, lat, lon) {
    const times = hourly.time;
    const s = timeMs / 1000;
    let i = 0;
    while (i < times.length - 2 && times[i + 1] <= s) i++;
    const t = Math.min(1, Math.max(0, (s - times[i]) / (times[i + 1] - times[i])));
    const at = (key) => lerpAt(hourly[key], i, t);
    const cover = { total: at('cloud_cover'), low: at('cloud_cover_low'), mid: at('cloud_cover_mid'), high: at('cloud_cover_high') };
    const code = hourly.weather_code[t < 0.5 ? i : i + 1] ?? 0;
    const tempC = Math.round(at('temperature_2m') * 10) / 10;
    const clouds = classifyClouds({ ...cover, code });
    const visibilityM = visibilityFor(hourly.visibility ? at('visibility') : null, code);
    setAirTempC(tempC);
    setVisibilityM(visibilityM);
    if (!cloudOverride) setCloudPreset(clouds);
    if (liveWetness) setWetness(carryWetness(timeMs, lat, lon, { tempC, cover, precipMmH: at('precipitation'), windMs: at('wind_speed_10m') }));
    setForecast({ tempC, clouds, code, precipMm: at('precipitation'), visibilityM, cover });
  }

  /**
   * Live road wetness: first from dry a day before through the forecast history, then stepped on by
   * the weather now with the debug overrides in. Elapsed time is real time x TIME_SCALE, as the
   * simulated clock wraps at midnight and stands still on a time preset.
   */
  function carryWetness(timeMs, lat, lon, w) {
    const now = Date.now();
    if (wetness == null) {
      wetness = integrateWetness(0, timeMs - MS_PER_DAY, timeMs, hours, lat, lon);
    } else {
      const weather = {
        ...w,
        tempC: getAirTempOverrideC() ?? w.tempC,
        precipMmH: getRainOverrideMmH() ?? w.precipMmH,
        cover: cloudOverride ? { total: PRESET_COVER[cloudOverride] ?? w.cover.total } : w.cover,
      };
      const hoursPassed = ((now - wetAtRealMs) * TIME_SCALE) / MS_PER_HOUR;
      wetness = stepWetness(wetness, hoursPassed, weather, sunDirection(timeMs, lat, lon).up);
    }
    wetAtRealMs = now;
    return wetness;
  }

  /** Call once per frame with the car's lat/lon and the simulated time (ms). */
  function update(lat, lon, timeMs) {
    if (!enabled) return;
    const now = Date.now();
    const moved = !hourly || distanceKm(lat, lon, fetchedAt.lat, fetchedAt.lon) > WEATHER_REFETCH_KM;
    const stale = moved || now - fetchedAt.ms > WEATHER_REFETCH_MIN * 60_000;
    if (stale && !inFlight && now >= retryAt) refetch(lat, lon, moved);
    if (hourly && now >= nextSampleAt) {
      nextSampleAt = now + SAMPLE_INTERVAL_MS;
      sample(timeMs, lat, lon);
    }
  }

  /** Debug: force a cloud preset, or null to follow the forecast. */
  function setCloudOverride(preset) {
    cloudOverride = preset;
    if (preset) setCloudPreset(preset);
    nextSampleAt = 0;
  }

  /** Off while a game mode sets the weather itself (rally). */
  function setEnabled(on) {
    if (on && !enabled) wetness = null; // the game mode drove the road meanwhile
    enabled = on;
    nextSampleAt = 0;
  }

  /** Debug: road wetness from the forecast history and the weather now (on), or left as set (off). */
  function setLiveWetness(on) {
    if (on && !liveWetness) wetness = null;
    liveWetness = on;
    nextSampleAt = 0;
  }

  return { update, setEnabled, setLiveWetness, getLiveWetness: () => liveWetness, setCloudOverride, getCloudOverride: () => cloudOverride, hasForecast: () => !!hourly };
}
