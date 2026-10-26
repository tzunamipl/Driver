// Current weather, read by gameplay and visuals: outside air temperature (engine heat,
// tyre temps), surface wetness (tyre wet grip floor, wet road look), the cloud preset and
// rainfall (rain.js). Fed by app/weatherFeed.js (forecast), app/rally/rallyConditions.js
// and the debug weather controls; the config values hold until the first forecast arrives.

import { AMBIENT_TEMP_C, WEATHER_WETNESS } from '../config.js';

// Sky presets, clearest first (clouds.js draws them).
export const CLOUD_PRESETS = ['clear', 'fair', 'cumulus', 'cirrus', 'patchy', 'broken', 'overcast'];

const state = {
  airTempC: AMBIENT_TEMP_C,
  airTempOverrideC: null, // debug: wins over every feed
  wetness: WEATHER_WETNESS,
  clouds: 'cumulus',
  rainMmH: 0,
  rainOverrideMmH: null, // debug: wins over every feed
  // Forecast extras for the debug readout: { tempC, clouds, precipMm, cover: { low, mid, high } } or null.
  forecast: null,
};
const listeners = new Set();

function changed() {
  for (const fn of listeners) fn(state);
}

export const getAirTempC = () => state.airTempOverrideC ?? state.airTempC;
export const getWetness = () => state.wetness;
export const getCloudPreset = () => state.clouds;
export const getForecast = () => state.forecast;
export const getRainMmH = () => state.rainOverrideMmH ?? state.rainMmH;

export function setAirTempC(tempC) {
  if (!Number.isFinite(tempC) || tempC === state.airTempC) return;
  state.airTempC = tempC;
  changed();
}

/** Debug: force the air temperature (°C), or null to follow the feeds again. */
export function setAirTempOverrideC(tempC) {
  const next = Number.isFinite(tempC) ? tempC : null;
  if (next === state.airTempOverrideC) return;
  state.airTempOverrideC = next;
  changed();
}

export const getAirTempOverrideC = () => state.airTempOverrideC;

/** 0 dry .. 1 soaked. */
export function setWetness(wetness) {
  const w = Math.min(1, Math.max(0, wetness));
  if (w === state.wetness) return;
  state.wetness = w;
  changed();
}

export function setCloudPreset(preset) {
  if (!CLOUD_PRESETS.includes(preset) || preset === state.clouds) return;
  state.clouds = preset;
  changed();
}

/** Rainfall in mm/h (0 = none). */
export function setRainMmH(mmH) {
  const r = Number.isFinite(mmH) ? Math.max(0, mmH) : 0;
  if (r === state.rainMmH) return;
  state.rainMmH = r;
  changed();
}

/** Debug: force the rainfall (mm/h), or null to follow the feeds again. */
export function setRainOverrideMmH(mmH) {
  const next = Number.isFinite(mmH) ? Math.max(0, mmH) : null;
  if (next === state.rainOverrideMmH) return;
  state.rainOverrideMmH = next;
  changed();
}

export const getRainOverrideMmH = () => state.rainOverrideMmH;

export function setForecast(forecast) {
  state.forecast = forecast;
  changed();
}

/** Calls `fn(state)` on every change; returns an unsubscribe. */
export function onWeatherChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
