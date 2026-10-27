// A rally's weather: the Open-Meteo forecast at the rally, fetched once when it starts and
// boiled down to a few snapshots per day (kept in the rally's save, so a game resumed days
// later drives the same weather), plus a road wetness model: rain wets it, warmth, sun and
// wind dry it.

import { sunDirection } from '../sunPosition.js';
import { NO_FOG_VISIBILITY_M } from '../weather.js';

const API_URL = 'https://api.open-meteo.com/v1/forecast';
const HOURLY = ['temperature_2m', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'precipitation', 'weather_code', 'wind_speed_10m', 'visibility'];
const FETCH_TIMEOUT_MS = 8_000;
const MAX_FORECAST_DAYS = 16;
export const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
// Local hours of the snapshots: night, morning, noon, afternoon. Each one averages the
// rain of the hours closest to it, so no shower falls between two of them.
const SNAPSHOT_HOURS = [2, 8, 13, 18];

// Wetness 0..1 per hour: gained per mm/h of rain; lost by a base rate plus warmth, sunshine and wind.
const WET_PER_MM = 0.4;
const DRY_BASE = 0.02;
const DRY_PER_DEG = 0.004;
const DRY_SUN = 0.25; // full sun straight overhead, clear sky
const DRY_PER_MS_WIND = 0.01;
const DRY_FROZEN = 0.01; // below 0 °C
const DRYING_IN_RAIN = 0.3; // share of the drying left while it still rains
const RAINING_MM_H = 0.05;
const STEP_MS = 10 * 60_000;
const FOG_CODE_VISIBILITY_M = 300; // WMO 45 / 48 (fog) at most this, whatever the model's visibility says

/** Visibility (m) from the forecast's value and WMO code; missing (older saves, offline) = from the code alone. */
export function visibilityFor(visibilityM, code) {
  const v = Number.isFinite(visibilityM) ? Math.min(NO_FOG_VISIBILITY_M, visibilityM) : NO_FOG_VISIBILITY_M;
  return code === 45 || code === 48 ? Math.min(v, FOG_CODE_VISIBILITY_M) : v;
}

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Epoch ms of local midnight (UTC offset `offsetSec`) of the day `ms` falls on. */
export function localDayStart(ms, offsetSec) {
  const local = ms + offsetSec * 1000;
  return local - (((local % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) - offsetSec * 1000;
}

/** Rough UTC offset from longitude, for when the forecast (which knows the time zone) can't be had. */
export const guessUtcOffsetSec = (lon) => Math.round(lon / 15) * 3600;

/** Local UTC offset at lat/lon now (Open-Meteo `timezone=auto`), or a guess from longitude when offline. */
export async function fetchUtcOffsetSec(lat, lon) {
  try {
    const params = new URLSearchParams({ latitude: lat.toFixed(3), longitude: lon.toFixed(3), timezone: 'auto', forecast_days: '1' });
    const res = await fetch(`${API_URL}?${params}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const json = await res.json();
    if (Number.isFinite(json.utc_offset_seconds)) return json.utc_offset_seconds;
  } catch (err) {
    console.warn('Time zone unavailable:', err.message);
  }
  return guessUtcOffsetSec(lon);
}

/**
 * Snapshots for the local day before `firstDayMs` (local midnight of the rally's day 1) through `days` rally days.
 * @returns {Promise<{ utcOffsetSec: number, snapshots: object[] }>} snapshots: [{ ms, tempC, cover: { total, low, mid, high }, code, precipMmH, windMs, visibilityM }].
 */
export async function fetchRallyWeather(lat, lon, firstDayMs, days) {
  const params = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    hourly: HOURLY.join(','),
    timeformat: 'unixtime',
    timezone: 'auto',
    wind_speed_unit: 'ms',
    // Dates are in the rally's time zone and firstDayMs is a UTC instant: the range runs a day long either side.
    start_date: isoDate(firstDayMs - MS_PER_DAY),
    end_date: isoDate(Math.min(firstDayMs + days * MS_PER_DAY, Date.now() + (MAX_FORECAST_DAYS - 1) * MS_PER_DAY)),
  });
  const res = await fetch(`${API_URL}?${params}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const json = await res.json();
  const hourly = json.hourly;
  if (!hourly?.time?.length) throw new Error('Open-Meteo: no hourly data');
  const utcOffsetSec = json.utc_offset_seconds ?? 0;
  return { utcOffsetSec, snapshots: toSnapshots(hourly, utcOffsetSec) };
}

function toSnapshots(hourly, offsetSec) {
  const times = hourly.time.map((s) => s * 1000);
  const num = (key, i) => hourly[key][i] ?? 0;
  const snapshots = [];
  const firstDay = localDayStart(times[0], offsetSec);
  for (let day = firstDay; day <= times.at(-1); day += MS_PER_DAY) {
    SNAPSHOT_HOURS.forEach((hour, k) => {
      const ms = day + hour * MS_PER_HOUR;
      const i = times.findIndex((t) => t >= ms);
      if (i < 0 || times[i] - ms >= MS_PER_HOUR) return;
      // Window: halfway to the neighbouring snapshots (wrapping over midnight).
      const prev = k > 0 ? SNAPSHOT_HOURS[k - 1] : SNAPSHOT_HOURS.at(-1) - 24;
      const next = k < SNAPSHOT_HOURS.length - 1 ? SNAPSHOT_HOURS[k + 1] : SNAPSHOT_HOURS[0] + 24;
      const from = day + ((prev + hour) / 2) * MS_PER_HOUR;
      const to = day + ((hour + next) / 2) * MS_PER_HOUR;
      let rain = 0;
      let wind = 0;
      let code = 0;
      let n = 0;
      times.forEach((t, j) => {
        if (t < from || t >= to) return;
        rain += num('precipitation', j);
        wind += num('wind_speed_10m', j);
        code = Math.max(code, num('weather_code', j));
        n++;
      });
      snapshots.push({
        ms,
        tempC: num('temperature_2m', i),
        cover: { total: num('cloud_cover', i), low: num('cloud_cover_low', i), mid: num('cloud_cover_mid', i), high: num('cloud_cover_high', i) },
        code: n ? code : num('weather_code', i),
        precipMmH: n ? rain / n : num('precipitation', i),
        windMs: n ? wind / n : num('wind_speed_10m', i),
        visibilityM: visibilityFor(hourly.visibility?.[i], num('weather_code', i)),
      });
    });
  }
  return snapshots;
}

const lerp = (a, b, t) => a + (b - a) * t;

/** Short sky wording for a snapshot (sampleWeather shape): the WMO code, else the cloud cover. */
export function skyLabel({ code, cover }) {
  if (code >= 95) return 'Thunderstorm';
  if (code >= 85) return 'Snow showers';
  if (code >= 80) return 'Showers';
  if (code >= 71) return 'Snow';
  if (code >= 61) return 'Rain';
  if (code >= 56) return 'Freezing drizzle';
  if (code >= 51) return 'Drizzle';
  if (code >= 45) return 'Fog';
  return cover.total < 20 ? 'Clear' : cover.total < 60 ? 'Partly cloudy' : cover.total < 90 ? 'Cloudy' : 'Overcast';
}

/** Weather at `ms` between the snapshots (held at the ends), or null without any. */
export function sampleWeather(snapshots, ms) {
  if (!snapshots?.length) return null;
  let i = 0;
  while (i < snapshots.length - 2 && snapshots[i + 1].ms <= ms) i++;
  const a = snapshots[i];
  const b = snapshots[i + 1] ?? a;
  const t = b === a ? 0 : Math.min(1, Math.max(0, (ms - a.ms) / (b.ms - a.ms)));
  // Fog thickens / thins by factors: lerp in log space.
  const logVis = (s) => Math.log(visibilityFor(s.visibilityM, s.code));
  return {
    tempC: lerp(a.tempC, b.tempC, t),
    cover: {
      total: lerp(a.cover.total, b.cover.total, t),
      low: lerp(a.cover.low, b.cover.low, t),
      mid: lerp(a.cover.mid, b.cover.mid, t),
      high: lerp(a.cover.high, b.cover.high, t),
    },
    code: t < 0.5 ? a.code : b.code,
    precipMmH: lerp(a.precipMmH, b.precipMmH, t),
    windMs: lerp(a.windMs, b.windMs, t),
    visibilityM: Math.exp(lerp(logVis(a), logVis(b), t)),
  };
}

/** Wetness after `hours` of weather `w` with the sun `sunUp` (sine of its elevation, 0 when down). */
export function stepWetness(wetness, hours, w, sunUp) {
  const raining = w.precipMmH > RAINING_MM_H;
  const dry =
    w.tempC <= 0
      ? DRY_FROZEN
      : DRY_BASE + DRY_PER_DEG * w.tempC + DRY_SUN * Math.max(0, sunUp) * (1 - w.cover.total / 100) + DRY_PER_MS_WIND * w.windMs;
  const change = (raining ? w.precipMmH * WET_PER_MM - dry * DRYING_IN_RAIN : -dry) * hours;
  return Math.min(1, Math.max(0, wetness + change));
}

/** Wetness carried from `fromMs` to `toMs` through the snapshots at lat/lon. */
export function integrateWetness(wetness, fromMs, toMs, snapshots, lat, lon) {
  if (!snapshots?.length) return wetness;
  for (let t = fromMs; t < toMs; t += STEP_MS) {
    const dt = Math.min(STEP_MS, toMs - t);
    const mid = t + dt / 2;
    wetness = stepWetness(wetness, dt / MS_PER_HOUR, sampleWeather(snapshots, mid), sunDirection(mid, lat, lon).up);
  }
  return wetness;
}
